/**
 * A customer messages the business number, and the CRM has it.
 *
 * The official WhatsApp route, from the webhook inwards. What only a real
 * database can answer, and all of it the kind of thing that goes wrong
 * silently:
 *
 *  * the message lands on the *existing* contact, matched on the last ten
 *    digits, rather than opening a second one;
 *  * a provider retrying the same delivery — which Meta does for days — adds
 *    nothing the second time;
 *  * an unknown number is kept unattached for a person to claim, never
 *    invented as a new contact;
 *  * a status only ever moves forward, because providers deliver them out of
 *    order and a late "sent" would otherwise un-read a read message.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { applyStatus, receiveInbound } from '../../src/integrations/whatsapp/business/inbound.js';
import { metaCloudProvider } from '../../src/integrations/whatsapp/business/metaCloud.js';
import { adminContext } from './fixtures.js';

const PROVIDER = 'whatsapp_meta';
const stamp = Date.now();
const KNOWN = `98${String(stamp).slice(-8)}`;
const UNKNOWN = `97${String(stamp).slice(-8)}`;

let recordId = '';

/** One delivery in the exact shape the Cloud API posts. */
function delivery(from: string, id: string, text: string): unknown {
  return {
    entry: [{
      changes: [{
        value: {
          metadata: { display_phone_number: '918800000000' },
          contacts: [{ wa_id: from, profile: { name: 'Webhook Test' } }],
          messages: [{
            from, id, timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text', text: { body: text },
          }],
        },
      }],
    }],
  };
}

beforeAll(async () => {
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `Business WhatsApp ${stamp}`,
    mobile: KNOWN,
    status: 'New',
  });
  recordId = lead.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE provider = $1`, [PROVIDER]);
  await db.query(
    `DELETE FROM ipy_conversation WHERE handle IN ($1, $2)`,
    [`91${KNOWN}`.slice(-10), `91${UNKNOWN}`.slice(-10)],
  );
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('the official WhatsApp webhook', () => {
  it('parses a Cloud API delivery into the CRM\'s own words', () => {
    const batch = metaCloudProvider.parseWebhook(delivery(`91${KNOWN}`, 'wamid.PARSE', 'hello'));
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).toMatchObject({
      providerMessageId: 'wamid.PARSE', from: `91${KNOWN}`, type: 'text', text: 'hello',
    });
    // Seconds, not milliseconds: reading it the other way puts every message
    // in January 1970 and the Inbox sorts them to the bottom for ever.
    expect(batch.messages[0].sentAt.getFullYear()).toBeGreaterThan(2000);
  });

  it('files the message against the contact that already holds the number', async () => {
    const [message] = metaCloudProvider.parseWebhook(
      delivery(`91${KNOWN}`, `wamid.${stamp}.1`, 'Is the flat still available?'),
    ).messages;

    const stored = await receiveInbound(PROVIDER, message);
    expect(stored).not.toBeNull();
    expect(stored!.recordId).toBe(recordId);
    expect(stored!.unmatched).toBe(false);

    const row = await db.queryOne<{ body: string; route: string; direction: string }>(
      `SELECT body, route, direction FROM ipy_message WHERE id = $1`, [stored!.messageId],
    );
    expect(row).toMatchObject({
      body: 'Is the flat still available?', route: 'business', direction: 'inbound',
    });

    // And the 24-hour window is open, which is what lets a rep reply in their
    // own words rather than with a template.
    const conversation = await db.queryOne<{ window_expires_at: string | null }>(
      `SELECT window_expires_at FROM ipy_conversation WHERE id = $1`, [stored!.conversationId],
    );
    expect(new Date(conversation!.window_expires_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('adds nothing when the provider retries the same delivery', async () => {
    const [message] = metaCloudProvider.parseWebhook(
      delivery(`91${KNOWN}`, `wamid.${stamp}.1`, 'Is the flat still available?'),
    ).messages;

    const again = await receiveInbound(PROVIDER, message);
    expect(again, 'a retried delivery must not become a second message').toBeNull();

    const count = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM ipy_message WHERE provider_message_id = $1`,
      [`wamid.${stamp}.1`],
    );
    expect(Number(count!.n)).toBe(1);
  });

  it('keeps an unknown number unattached rather than inventing a contact', async () => {
    const before = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_record WHERE is_deleted = false`);

    const [message] = metaCloudProvider.parseWebhook(
      delivery(`91${UNKNOWN}`, `wamid.${stamp}.2`, 'Saw your board outside'),
    ).messages;
    const stored = await receiveInbound(PROVIDER, message);

    expect(stored!.recordId).toBeNull();
    expect(stored!.unmatched).toBe(true);

    const after = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_record WHERE is_deleted = false`);
    expect(Number(after!.n), 'nobody may be created behind a rep\'s back').toBe(Number(before!.n));
  });

  it('moves a status forward and never backwards', async () => {
    // An outbound message to carry the statuses.
    const conversation = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_conversation WHERE handle = $1 AND wa_account_id IS NULL`,
      [`91${KNOWN}`.slice(-10)],
    );
    const sent = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, provider_message_id, provider, route)
       VALUES ($1, 'outbound', 'whatsapp', 'text', 'On my way', 'sent', $2, $3, 'business')
       RETURNING id`,
      [conversation!.id, `wamid.${stamp}.out`, PROVIDER],
    );

    const at = new Date();
    expect(await applyStatus(PROVIDER, {
      providerMessageId: `wamid.${stamp}.out`, state: 'read', at, error: null,
    })).toBe(true);

    // Out of order, which providers do: the earlier state must not win.
    expect(await applyStatus(PROVIDER, {
      providerMessageId: `wamid.${stamp}.out`, state: 'delivered', at, error: null,
    })).toBe(false);

    const row = await db.queryOne<{ status: string; read_at: string | null }>(
      `SELECT status, read_at FROM ipy_message WHERE id = $1`, [sent!.id],
    );
    expect(row!.status).toBe('read');
    expect(row!.read_at).not.toBeNull();
  });

  it('refuses a delivery that is not signed by the provider', () => {
    // No credentials are configured in the test database, so the adapter has
    // no app secret — and a webhook it cannot check must be refused rather
    // than trusted. An endpoint that authenticates nobody is the bug this
    // whole check exists to prevent.
    const check = metaCloudProvider.verifyWebhook({
      method: 'POST', query: {}, headers: { 'x-hub-signature-256': 'sha256=nonsense' }, rawBody: '{}',
    });
    expect(check.ok).toBe(false);
  });
});
