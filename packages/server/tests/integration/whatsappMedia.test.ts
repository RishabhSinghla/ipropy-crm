/**
 * A customer's photo has to still be there in a year.
 *
 * The owner's specification says it in as many words: the CRM's history must
 * not depend on the provider's dashboard. A webhook hands over a media id that
 * expires, or a URL that needs the account's own token — store either of those
 * and the album empties itself the day the business changes vendor, silently,
 * with nothing that looks like an error until somebody opens an old chat.
 *
 * So these prove the four things a real database is needed for:
 *
 *  * the file is fetched and kept as an ordinary attachment, and the message
 *    points at **the CRM's copy**, never at the vendor's link;
 *  * a fetch that fails leaves the message and its caption standing, because
 *    losing both is worse than losing one and a throw here earns a retry that
 *    delivers the whole conversation twice;
 *  * the signed link a reseller fetches from is genuinely signed — a changed
 *    id, a changed expiry or a stale one is refused;
 *  * a file WhatsApp will not carry is refused *before* anything is sent, with
 *    the real size named, rather than minutes later as a vendor error code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import {
  keepInboundMedia, mediaLinkValid, mediaTypeFor, prepareOutgoingMedia, signMediaLink,
} from '../../src/integrations/whatsapp/business/media.js';
import type {
  MediaBytes, MediaRef, WhatsAppBusinessProvider,
} from '../../src/integrations/whatsapp/business/types.js';

const stamp = Date.now();
const HANDLE = `9888${String(stamp).slice(-6)}`;

let conversationId = '';
let messageId = '';
const attachments: string[] = [];

/** A provider that answers with bytes, without a network or a vendor. */
function stubProvider(over: Partial<WhatsAppBusinessProvider> = {}): WhatsAppBusinessProvider {
  return {
    name: 'stub',
    kind: 'business',
    capabilities: new Set(['text', 'media']),
    mediaTransport: 'upload',
    async fetchMedia(_ref: MediaRef): Promise<MediaBytes | null> {
      return { data: Buffer.from('a tiny jpeg, honestly'), mimeType: 'image/jpeg', filename: null };
    },
    async uploadMedia() { return 'vendor-media-id'; },
    ...over,
  } as unknown as WhatsAppBusinessProvider;
}

beforeAll(async () => {
  const conversation = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle) VALUES ('whatsapp', $1) RETURNING id`,
    [HANDLE],
  );
  conversationId = conversation!.id;
  const message = await db.queryOne<{ id: string }>(
    // Seeded the way `receiveInbound` writes it: the provider's own descriptor
    // goes on first, and keeping the file merges the CRM's copy into it.
    `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, media, status, route)
     VALUES ($1, 'inbound', 'whatsapp', 'image', 'look at this one', $2::jsonb, 'delivered', 'business')
     RETURNING id`,
    [conversationId, JSON.stringify({ id: 'vendor-id-that-expires', mimeType: 'image/jpeg' })],
  );
  messageId = message!.id;
});

afterAll(async () => {
  if (attachments.length) {
    await db.query(`DELETE FROM ipy_attachment WHERE id = ANY($1::uuid[])`, [attachments]);
  }
  await db.query(`DELETE FROM ipy_conversation WHERE handle = $1`, [HANDLE]);
});

describe('keeping what a customer sent', () => {
  it('stores the file and points the message at the CRM\'s own copy', async () => {
    const kept = await keepInboundMedia({
      provider: stubProvider(),
      messageId,
      recordId: null,
      ref: { id: 'vendor-id-that-expires', mimeType: 'image/jpeg' },
    });

    expect(kept, 'nothing was kept').not.toBeNull();
    attachments.push(kept!.attachmentId);

    const file = await db.queryOne<{ mime_type: string; size: string | number; storage_key: string; category: string }>(
      `SELECT mime_type, size, storage_key, category FROM ipy_attachment WHERE id = $1`,
      [kept!.attachmentId],
    );
    expect(file?.mime_type).toBe('image/jpeg');
    expect(Number(file?.size)).toBeGreaterThan(0);
    // Filed like any other attachment, so it appears on the contact's Files
    // tab rather than only inside one chat screen.
    expect(file?.category).toBe('whatsapp');

    const row = await db.queryOne<{ media: Record<string, unknown> }>(
      `SELECT media FROM ipy_message WHERE id = $1`, [messageId],
    );
    expect(row!.media.attachmentId).toBe(kept!.attachmentId);
    expect(row!.media.url).toBe(`/api/files/${kept!.attachmentId}`);
    // The vendor's own id is kept beside the CRM's, never instead of it — it
    // is what a support conversation with the vendor is about.
    expect(row!.media.id, 'the provider\'s id was thrown away').toBe('vendor-id-that-expires');
  });

  it('leaves the message standing when the file cannot be collected', async () => {
    const other = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, route)
       VALUES ($1, 'inbound', 'whatsapp', 'document', 'the agreement', 'delivered', 'business')
       RETURNING id`,
      [conversationId],
    );

    const kept = await keepInboundMedia({
      provider: stubProvider({ async fetchMedia() { throw new Error('vendor is down'); } }),
      messageId: other!.id,
      recordId: null,
      ref: { id: 'never-arrives' },
    });

    expect(kept, 'a failed fetch must not pretend it worked').toBeNull();
    const row = await db.queryOne<{ body: string }>(
      `SELECT body FROM ipy_message WHERE id = $1`, [other!.id],
    );
    expect(row?.body, 'the message itself was lost with the file').toBe('the agreement');
  });
});

describe('the link a reseller fetches from', () => {
  it('accepts its own signature and nothing else', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const { exp, sig } = signMediaLink(id);

    expect(mediaLinkValid(id, exp, sig)).toBe(true);
    // A different file with the same signature — the whole point of signing
    // the id rather than just minting a random token.
    expect(mediaLinkValid('99999999-2222-3333-4444-555555555555', exp, sig)).toBe(false);
    // A longer life, claimed by editing the URL.
    expect(mediaLinkValid(id, exp + 86_400, sig)).toBe(false);
    // Change a character to a *different* valid hex digit. Appending `0`
    // incorrectly left the signature unchanged whenever it already ended in
    // `0`, making this security test flaky.
    const alteredSignature = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    expect(mediaLinkValid(id, exp, alteredSignature)).toBe(false);
    expect(mediaLinkValid(id, exp, 'short')).toBe(false);
  });

  it('stops working once it is past', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const { exp, sig } = signMediaLink(id, -60);
    expect(mediaLinkValid(id, exp, sig)).toBe(false);
  });
});

describe('handing a file to the provider', () => {
  it('names the four kinds the way WhatsApp does', () => {
    expect(mediaTypeFor('image/png')).toBe('image');
    expect(mediaTypeFor('video/mp4')).toBe('video');
    // A WhatsApp voice note, which is opus in an ogg container.
    expect(mediaTypeFor('audio/ogg; codecs=opus')).toBe('audio');
    expect(mediaTypeFor('application/pdf')).toBe('document');
    expect(mediaTypeFor('application/octet-stream')).toBe('document');
  });

  it('refuses a file WhatsApp will not carry, with the size named', async () => {
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_attachment (file_name, mime_type, size, storage_key)
       VALUES ('drone-tour.mp4', 'video/mp4', $1, 'nowhere/drone-tour.mp4')
       RETURNING id`,
      [90 * 1024 * 1024],
    );
    attachments.push(row!.id);

    await expect(prepareOutgoingMedia(stubProvider(), row!.id))
      .rejects.toThrow(/will not carry a video over 16MB, and this one is 90MB/);
  });

  it('asks an uploading provider for its id, and never publishes a link', async () => {
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_attachment (file_name, mime_type, size, storage_key)
       VALUES ('floor-plan.pdf', 'application/pdf', 2048, $1)
       RETURNING id`,
      [`unfiled/test/${stamp}-floor-plan.pdf`],
    );
    attachments.push(row!.id);

    const { getDriver } = await import('../../src/core/storage/index.js');
    const driver = await getDriver();
    await driver.save(`unfiled/test/${stamp}-floor-plan.pdf`, Buffer.from('%PDF-1.4 pretend'), 'application/pdf');

    const ready = await prepareOutgoingMedia(stubProvider(), row!.id);
    expect(ready.mediaId).toBe('vendor-media-id');
    expect(ready.link, 'an uploading provider must not publish the file').toBeUndefined();
    expect(ready.type).toBe('document');
  });

  it('publishes a signed link for a provider that can only fetch one', async () => {
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_attachment (file_name, mime_type, size, storage_key)
       VALUES ('unit-photo.jpg', 'image/jpeg', 4096, 'nowhere/unit-photo.jpg')
       RETURNING id`,
    );
    attachments.push(row!.id);

    const ready = await prepareOutgoingMedia(
      stubProvider({ mediaTransport: 'link' }),
      row!.id,
    );
    expect(ready.mediaId).toBeUndefined();
    expect(ready.link).toContain(`/api/public/whatsapp-media/${row!.id}`);

    // And that link has to be one the route will actually accept.
    const url = new URL(ready.link!, 'https://example.test');
    expect(mediaLinkValid(row!.id, url.searchParams.get('exp'), url.searchParams.get('sig'))).toBe(true);
  });
});
