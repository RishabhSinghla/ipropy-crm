/**
 * Photos, documents and voice notes — the CRM's own copy of both directions.
 *
 * The rule this whole file exists for is one line of the owner's
 * specification: **the CRM's history must never depend on the provider's
 * dashboard.** A webhook hands over a media id that expires, or a URL that
 * needs the account's own token. A CRM that stores either of those has a photo
 * album that quietly empties itself — the picture a customer sent is gone the
 * day the business changes vendor, and nothing about it looks like an error
 * until somebody opens an old conversation and finds a broken square.
 *
 * So an inbound file is fetched once, now, and stored as an ordinary
 * `ipy_attachment`, exactly like a file somebody dragged onto the record. It
 * then shows on the contact's Files tab, gets its image derivatives, and
 * survives every vendor decision made afterwards.
 *
 * Going out, the two halves of the world disagree and neither is a choice:
 *
 *  * **Meta takes an upload.** The bytes go to Meta, Meta gives an id back,
 *    the id is what gets sent. Nothing of the customer's is published.
 *  * **Every reseller takes a link** and offers no upload at all. So the CRM
 *    has to put the file somewhere they can reach, and the only honest way to
 *    do that is a URL that is signed, that names exactly one file, and that
 *    stops working shortly afterwards. It is a real exposure for that window,
 *    it is the vendors' design rather than this one's, and it is why Meta
 *    direct is the better of the four.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../../../db/pool.js';
import { config as appConfig } from '../../../config.js';
import { getDriver } from '../../../core/storage/index.js';
import { buildStorageKey } from '../../../core/storage/keys.js';
import { logger } from '../../../utils/logger.js';
import { BadRequestError } from '../../../utils/errors.js';
import type { MediaRef, WhatsAppBusinessProvider } from './types.js';

/** What WhatsApp will carry, and what the CRM calls each one. */
export type WhatsAppMediaType = 'image' | 'document' | 'audio' | 'video';

/**
 * WhatsApp's own ceilings, which are lower than most people expect.
 *
 * Checked against Meta's published limits from knowledge rather than from the
 * page (`developers.facebook.com` is blocked here). Being slightly wrong is
 * cheap in this direction: a file under the limit is accepted, and one the
 * provider refuses comes back as a named failure on the message instead of a
 * silent nothing. Being wrong the other way — no limit at all — is a rep
 * watching a 90MB video fail after two minutes with no explanation.
 */
const MAX_BYTES: Record<WhatsAppMediaType, number> = {
  image: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

/** A mime type to the four kinds WhatsApp actually has. */
export function mediaTypeFor(mimeType: string): WhatsAppMediaType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

/** A file extension for something that arrived with a mime type and no name. */
function extensionFor(mimeType: string): string {
  const known: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp',
    // A WhatsApp voice note is opus in an ogg container, and naming it
    // anything else stops every browser playing it back.
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/amr': '.amr',
    'application/pdf': '.pdf',
  };
  return known[mimeType.split(';')[0]!.trim()] ?? '';
}

// ---------------------------------------------------------------------------
// Coming in
// ---------------------------------------------------------------------------

export interface KeptMedia {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/**
 * Fetch what an inbound message referred to and keep it.
 *
 * Deliberately **after** the message row exists, never inside the webhook's
 * own transaction: collecting a 15MB video is a network round trip to the
 * vendor, and a provider that does not hear a prompt 200 sends the whole
 * delivery again. A file that fails to arrive leaves the message — the caption
 * and the fact that something was sent — rather than losing both.
 */
export async function keepInboundMedia(input: {
  provider: WhatsAppBusinessProvider;
  messageId: string;
  recordId: string | null;
  ref: MediaRef;
}): Promise<KeptMedia | null> {
  const { provider, messageId, recordId, ref } = input;
  if (!ref.id && !ref.link) return null;

  try {
    const file = await provider.fetchMedia(ref);
    if (!file || !file.data.byteLength) {
      logger.warn({ provider: provider.name, messageId }, 'WhatsApp media could not be collected');
      return null;
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const name = file.filename
      || ref.filename
      || `whatsapp-${new Date().toISOString().slice(0, 10)}-${messageId.slice(-6)}${extensionFor(mimeType)}`;

    const key = await buildStorageKey({
      recordId,
      originalName: name,
      ext: name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '',
    });
    const driver = await getDriver();
    await driver.save(key, file.data, mimeType);

    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_attachment
         (record_id, file_name, mime_type, size, storage_key, url, category)
       VALUES ($1,$2,$3,$4,$5,$6,'whatsapp')
       RETURNING id`,
      [recordId, name, mimeType, file.data.byteLength, key, `/api/files/${key}`],
    );

    /*
      The message now points at the CRM's own file. The provider's id is kept
      beside it rather than replaced: it is what a support conversation with
      the vendor is about, and it costs one key.
    */
    await db.query(
      `UPDATE ipy_message
          SET media = COALESCE(media, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [messageId, JSON.stringify({
        attachmentId: row!.id,
        url: `/api/files/${row!.id}`,
        fileName: name,
        mimeType,
        size: file.data.byteLength,
      })],
    );

    return { attachmentId: row!.id, fileName: name, mimeType, size: file.data.byteLength };
  } catch (err) {
    // Never fatal. The message is already written and a rep can see that
    // something came; a thrown error here would answer the webhook late and
    // earn a retry that delivers the same message twice.
    logger.warn({ err, provider: provider.name, messageId }, 'keeping WhatsApp media failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Going out — the signed link, for providers that only fetch
// ---------------------------------------------------------------------------

/**
 * Sign one attachment for one short window.
 *
 * Not a row in a table: there is nothing to look up later, nothing to revoke
 * that expiry does not already handle, and a table of these would grow by one
 * row per picture forever. The signature covers the id *and* the expiry, so
 * neither can be edited without breaking it.
 */
export function signMediaLink(attachmentId: string, ttlSeconds = 900): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: mediaSignature(attachmentId, exp) };
}

function mediaSignature(attachmentId: string, exp: number): string {
  return createHmac('sha256', appConfig.auth.jwtSecret)
    .update(`wa-media:${attachmentId}:${exp}`)
    .digest('hex');
}

/** Is this link genuine, and is it still inside its window? */
export function mediaLinkValid(attachmentId: string, exp: unknown, sig: unknown): boolean {
  const expiry = Number(exp);
  if (!Number.isFinite(expiry) || typeof sig !== 'string') return false;
  if (expiry * 1000 < Date.now()) return false;
  const expected = Buffer.from(mediaSignature(attachmentId, expiry));
  const given = Buffer.from(sig);
  // Length first: `timingSafeEqual` throws on a mismatch rather than
  // answering false, and a thrown error here is a 500 on a public route.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The absolute URL a provider will fetch. Absolute, because they are not us. */
export function publicMediaUrl(attachmentId: string): string {
  const { exp, sig } = signMediaLink(attachmentId);
  const base = (appConfig.appUrl.split(',')[0] ?? '').trim().replace(/\/+$/, '');
  return `${base}/api/public/whatsapp-media/${attachmentId}?exp=${exp}&sig=${sig}`;
}

// ---------------------------------------------------------------------------
// Going out — handing the provider the file, whichever way it wants it
// ---------------------------------------------------------------------------

export interface OutgoingMedia {
  type: WhatsAppMediaType;
  fileName: string;
  mimeType: string;
  /** Set for providers that upload. */
  mediaId?: string;
  /** Set for providers that fetch a link. */
  link?: string;
}

/**
 * Prepare one of the CRM's own files for sending.
 *
 * The caller has already decided this user may read the record. What is
 * checked here is the file: that it exists, that WhatsApp will carry it, and
 * that it is not so large the send fails minutes later with a vendor's error
 * code as the only explanation.
 */
export async function prepareOutgoingMedia(
  provider: WhatsAppBusinessProvider, attachmentId: string,
): Promise<OutgoingMedia> {
  const file = await db.queryOne<{
    file_name: string; mime_type: string; size: string | number; storage_key: string;
  }>(
    `SELECT file_name, mime_type, size, storage_key FROM ipy_attachment WHERE id = $1`,
    [attachmentId],
  );
  if (!file) throw new BadRequestError('That file is no longer here.');

  const type = mediaTypeFor(file.mime_type);
  const size = Number(file.size ?? 0);
  if (size > MAX_BYTES[type]) {
    const mb = Math.round(MAX_BYTES[type] / (1024 * 1024));
    throw new BadRequestError(
      `WhatsApp will not carry ${type === 'document' ? 'a document' : `a ${type}`} over ${mb}MB, and this one is ${Math.round(size / (1024 * 1024))}MB.`,
    );
  }

  if (provider.mediaTransport === 'upload') {
    const driver = await getDriver();
    const stored = await driver.read(file.storage_key);
    if (!stored) throw new BadRequestError('That file is no longer in storage.');
    const mediaId = await provider.uploadMedia({
      data: stored,
      mimeType: file.mime_type,
      filename: file.file_name,
    });
    return { type, mediaId, fileName: file.file_name, mimeType: file.mime_type };
  }

  return { type, link: publicMediaUrl(attachmentId), fileName: file.file_name, mimeType: file.mime_type };
}
