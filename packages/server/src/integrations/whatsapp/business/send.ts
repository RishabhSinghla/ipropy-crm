/**
 * Sending on the business number, from inside the CRM.
 *
 * The row is written *before* the provider is called, in 'queued', and moved
 * to 'sent' when it answers. The other order looks tidier and loses messages:
 * a provider that accepts and then times out on the reply leaves a customer
 * with a message and the CRM with no record of it.
 *
 * Two rules the caller does not have to know about:
 *
 *  * **The 24-hour window.** Outside it WhatsApp only carries an approved
 *    template, so a free-text send is refused *here*, with the reason, rather
 *    than by the provider after a rep has typed a paragraph.
 *  * **Opt-out is final.** Somebody who asked not to be messaged is not
 *    messaged, whoever is asking and whatever the template says.
 */
import { db, onCommit, transaction } from '../../../db/pool.js';
import { bus } from '../../../core/events/bus.js';
import { BadRequestError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { requireCapability } from '../providers/types.js';
import { toInternational } from '@ipropy/shared';
import { matchKey } from '../matchContact.js';
import { activeBusinessProvider } from './registry.js';
import { whyItFailed } from './whyItFailed.js';
import { prepareOutgoingMedia } from './media.js';

const MODULE = 'leads';

export interface BusinessSendInput {
  userId: string;
  to: string;
  /** A free reply, only allowed while the window is open. */
  text?: string;
  /** An approved template, allowed at any time. */
  template?: { name: string; language: string; params: string[]; headerMedia?: { link: string; filename?: string } };
  /**
   * One of the CRM's own files, by attachment id — never a URL from the
   * browser. A caller that could name any link could make the CRM fetch and
   * republish anything it can reach, and the file a rep picked is already in
   * the CRM anyway.
   */
  attachmentId?: string;
  recordId?: string | null;
}

export interface BusinessSendResult {
  messageId: string;
  conversationId: string;
  providerMessageId: string;
  status: 'queued' | 'sent';
}

/** Has this person asked not to be messaged on WhatsApp? */
async function optedOut(handle: string): Promise<boolean> {
  /*
    `SELECT 1`, not `SELECT id`.

    `ipy_channel_optout` is keyed on `(handle, channel)` and **has no `id`
    column** — it never has. This asked for one, so every send on the official
    route died here with Postgres 42703, which the error handler turns into
    "Unknown field referenced in the request": a rep pressing Send on an
    approved template, and a message that never went.

    It survived because nothing ever ran it. The composer has never been opened
    against a live provider, and the tests that call `sendOnBusinessNumber`
    expect it to refuse *earlier* — at "no provider is switched on" — so the
    line below was never reached by anything until a customer was waiting.
  */
  const row = await db.queryOne<{ ok: number }>(
    `SELECT 1 AS ok FROM ipy_channel_optout
      WHERE channel = 'whatsapp' AND right(regexp_replace(handle, '\\D', '', 'g'), 10) = right($1, 10)
      LIMIT 1`,
    [handle],
  );
  return Boolean(row);
}

/** The business thread for this number, created on first contact from our side. */
async function conversationFor(handle: string, recordId: string | null, userId: string): Promise<{
  id: string; windowOpen: boolean; waId: string | null;
}> {
  const existing = await db.queryOne<{ id: string; window_expires_at: string | null; wa_id: string | null }>(
    `SELECT id, window_expires_at, wa_id FROM ipy_conversation
      WHERE channel = 'whatsapp' AND handle = $1 AND wa_account_id IS NULL LIMIT 1`,
    [handle],
  );
  if (existing) {
    /*
      Sending from a record is a person saying "this thread is this contact".

      `matchContact` tries on every inbound and is right most of the time, but
      it cannot be right when the contact did not exist yet, when two records
      share a number, or when the number sits in a field it does not read. A
      human pressing Send on a record settles all three, so the link is taken
      then — and `COALESCE` means it never steals a thread that already belongs
      to somebody else.
    */
    if (recordId) {
      await db.query(
        `UPDATE ipy_conversation
            SET record_id = COALESCE(record_id, $2), record_module = COALESCE(record_module, $3)
          WHERE id = $1`,
        [existing.id, recordId, MODULE],
      );
    }
    return {
      id: existing.id,
      windowOpen: Boolean(existing.window_expires_at && new Date(existing.window_expires_at) > new Date()),
      waId: existing.wa_id,
    };
  }
  const created = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, record_id, record_module, assigned_to)
     VALUES ('whatsapp', $1, $2, $3, $4)
     RETURNING id`,
    [handle, recordId, recordId ? MODULE : null, userId],
  );
  // Nobody has written to us, so there is no window: only a template may go.
  return { id: created!.id, windowOpen: false, waId: null };
}

/**
 * The number to actually send to — **never the handle.**
 *
 * `handle` is the last ten digits, on purpose: it is what matches a contact
 * whose mobile might be stored as `9891222206`, `+919891222206` or
 * `0 9891 222206`. It is a matching key and it was also being passed to the
 * provider as a destination, which is the bug this exists to close. WhatsApp
 * read ten digits as a different person from the `919891222206` who had just
 * written in, found no session for them, and refused every free-text reply
 * with *"Sending message outside 24 hour window is not allowed"* — which reads
 * exactly like a window bug and is not one.
 *
 * Three sources, best first:
 *
 *  1. **WhatsApp's own `wa_id`**, stored on the conversation from an inbound
 *     message. Authoritative: it is the number WhatsApp itself used.
 *  2. **What the caller passed**, when it already carries a country code.
 *  3. **The record's own country code plus its national number**, through
 *     `toInternational` — the one helper that knows how to put those back
 *     together.
 *
 * And when none of those give a country code it **refuses**, rather than
 * assuming +91. A silent Indian default sends an NRI buyer's message to a
 * stranger, and `toInternational`'s own comment says so.
 */
export /** The organisation's own default, or nothing. Never a code invented here. */
async function defaultCountryCode(): Promise<string> {
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'org.country_code'`,
  );
  return String(row?.value ?? '').replace(/\D/g, '');
}

export async function dialableNumber(
  waId: string | null, to: string, recordId: string | null,
): Promise<string | null> {
  if (waId) return waId;

  const given = to.replace(/\D/g, '');
  // More than ten digits means a country code is already in there.
  if (given.length > 10) return given;

  if (recordId) {
    const row = await db.queryOne<{ country_code: string | null; mobile: string | null }>(
      `SELECT to_jsonb(l)->>'country_code' AS country_code, to_jsonb(l)->>'mobile' AS mobile
         FROM ipy_e_leads l WHERE l.record_id = $1`,
      [recordId],
    );
    /*
      Only when the record actually carries a country code. `toInternational`
      falls back to `toE164` without one, and `toE164` assumes India — which is
      the silent default this function exists to refuse. An NRI buyer's message
      sent to a stranger in India cannot be taken back.
    */
    /*
      The record's own code first, then the organisation's.

      Refusing outright was right about the danger and wrong about the cost:
      most of this database was imported with a ten-digit mobile and no
      `country_code`, so on 20 September every one of those contacts was
      unreachable — the composer refused before the provider was called.

      What `toInternational`'s comment warns about is a default **nobody can
      see**. `org.country_code` is a row with a label in Admin → Settings, so
      an admin knows it exists and which country it names, and a contact that
      carries its own code still wins over it. That is a different thing from
      `toE164` quietly assuming India.
    */
    const code = (row?.country_code ?? '').replace(/\D/g, '') || await defaultCountryCode();
    if (code) {
      const full = toInternational(code, row?.mobile ?? to);
      const digits = (full ?? '').replace(/\D/g, '');
      if (digits.length > 10) return digits;
    }
  }
  return null;
}

export async function sendOnBusinessNumber(input: BusinessSendInput): Promise<BusinessSendResult> {
  const provider = activeBusinessProvider();
  if (!provider) throw new BadRequestError('No official WhatsApp provider is switched on.');

  const handle = matchKey(input.to);
  if (!handle) throw new BadRequestError('That is not a number WhatsApp can reach.');
  if (await optedOut(handle)) {
    throw new BadRequestError('This person has opted out of WhatsApp messages.');
  }

  const conversation = await conversationFor(handle, input.recordId ?? null, input.userId);

  const dialTo = await dialableNumber(conversation.waId, input.to, input.recordId ?? null);
  if (!dialTo) {
    throw new BadRequestError(
      'This number has no country code, so WhatsApp cannot be sure who to send to. '
      + 'Add one on the contact, or set a default in Admin → Settings → Default country code.',
    );
  }

  if (input.template) requireCapability(provider, 'templates');
  if (input.attachmentId) requireCapability(provider, 'media');
  if (!input.template) {
    requireCapability(provider, input.attachmentId ? 'media' : 'text');
    if (!conversation.windowOpen) {
      throw new BadRequestError(
        'This chat is outside WhatsApp\'s 24-hour window, so only an approved template can be sent.',
      );
    }
  }

  /*
    The provider is handed the file *before* the message row is written.

    Uploading to Meta or minting a signed link is the part that fails — a file
    too large for WhatsApp, storage that cannot find it — and failing here
    leaves nothing behind. Doing it after the row would leave a message stuck
    at 'queued' that nobody sent and nobody can retry.
  */
  const media = input.attachmentId
    ? await prepareOutgoingMedia(provider, input.attachmentId)
    : null;

  const body = input.template
    ? `[template: ${input.template.name}]`
    : input.text ?? (media ? media.fileName : '');

  // Written first, on purpose: a provider that accepts and then times out on
  // the answer must not leave the customer holding a message the CRM never
  // heard of.
  const queued = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_message
       (conversation_id, direction, channel, type, body, status, provider, route, sent_by,
        template_name, template_params, media)
     VALUES ($1, 'outbound', 'whatsapp', $2, $3, 'queued', $4, 'business', $5, $6, $7, $8)
     RETURNING id`,
    [
      conversation.id,
      input.template ? 'template' : media ? media.type : 'text',
      body,
      provider.name,
      input.userId,
      input.template?.name ?? null,
      input.template ? JSON.stringify(input.template.params) : null,
      // The CRM's own file, named the same way an inbound one is, so one
      // renderer draws both sides of the conversation.
      media && input.attachmentId
        ? JSON.stringify({
          attachmentId: input.attachmentId,
          url: `/api/files/${input.attachmentId}`,
          fileName: media.fileName,
          mimeType: media.mimeType,
        })
        : null,
    ],
  );

  try {
    const outcome = input.template
      ? await provider.sendTemplate({
        to: dialTo,
        templateName: input.template.name,
        language: input.template.language,
        params: input.template.params,
        headerMedia: input.template.headerMedia ?? null,
      })
      : media
        // Two ways in, because the vendors disagree and neither offers the
        // other: Meta takes the bytes and gives an id back, every reseller
        // fetches a link. `prepareOutgoingMedia` has already done whichever
        // one this provider asked for.
        ? media.mediaId
          ? await provider.sendMediaById({
            to: dialTo,
            type: media.type,
            mediaId: media.mediaId,
            caption: input.text || undefined,
            filename: media.fileName,
          })
          : await provider.sendMedia({
            accountId: null,
            to: dialTo,
            type: media.type,
            link: media.link!,
            caption: input.text || undefined,
            filename: media.fileName,
          })
        : await provider.sendMessage({ accountId: null, to: dialTo, text: input.text ?? '' });

    await transaction(async (conn) => {
      await conn.query(
        `UPDATE ipy_message SET status = $2, provider_message_id = $3 WHERE id = $1`,
        [queued!.id, outcome.status === 'sent' ? 'sent' : 'queued', outcome.providerMessageId || null],
      );
      await conn.query(
        `UPDATE ipy_conversation
            SET last_message_at = now(), last_message_preview = $2
          WHERE id = $1`,
        [conversation.id, body.slice(0, 200)],
      );
      onCommit(conn, async () => {
        bus.emit('message.sent', {
          conversationId: conversation.id,
          messageId: queued!.id,
          direction: 'outbound',
          channel: 'whatsapp',
          body,
          handle,
          recordId: input.recordId ?? null,
        });
      });
    });

    return {
      messageId: queued!.id,
      conversationId: conversation.id,
      providerMessageId: outcome.providerMessageId,
      status: outcome.status,
    };
  } catch (err) {
    // The failure is on the message, where a rep can see it and press Retry —
    // not only in a log nobody reads.
    const why = whyItFailed((err as Error).message).slice(0, 500);
    await db.query(
      `UPDATE ipy_message SET status = 'failed', error_message = $2 WHERE id = $1`,
      // Translated where the code is one we know, and never instead of the
      // provider's own words — see `whyItFailed`.
      [queued!.id, why],
    );
    logger.warn({ err, provider: provider.name }, 'WhatsApp business send failed');
    /*
      The same sentence goes back to the screen, not only onto the row. A
      provider refusing a message is an outcome a rep has to read — "outside
      the 24-hour window", "that template is not approved" — and rethrowing the
      raw error made it an unhandled 500, which the client can only render as
      *"Something went wrong on our end."* That tells a rep nothing and sends
      them hunting. Checked in a browser on 20 September 2026: the server knew
      exactly why and the screen did not.
    */
    throw new BadRequestError(why);
  }
}
