/**
 * A WhatsApp message on the contact's existing timeline.
 *
 * §7 asks for WhatsApp to join the timeline the CRM already has, beside the
 * calls, notes and follow-ups — not for a second feed. It already does: the
 * timeline reads `ipy_message` by record, and has since long before agent
 * linking. What this pins is that it still does, and that it now says which
 * number carried it.
 *
 * That last part is new and is the whole argument for per-agent numbers. With
 * one business number "sent via" had no answer worth printing; with a number
 * each it is the first thing somebody asks of a message they did not send.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { buildTimeline } from '../../src/core/entity/timeline.js';
import { recordLive } from '../../src/integrations/whatsapp/agent/store.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const national = String(9_800_000_000 + (stamp % 89_000_000));
let accountId: string;
let leadId: string;
let agentName: string;

beforeAll(async () => {
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `WhatsApp Timeline ${stamp}`, mobile: national,
  });
  leadId = lead.id;

  const me = await db.queryOne<{ name: string }>(
    `SELECT trim(first_name || ' ' || last_name) AS name FROM ipy_user WHERE id = $1`,
    [ctx.user.id],
  );
  agentName = me!.name;

  const account = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_account (user_id, label, phone_number, status)
     VALUES ($1,$2,$3,'connected') RETURNING id`,
    [ctx.user.id, `Timeline test ${stamp}`, `+9193${stamp % 100000000}`],
  );
  accountId = account!.id;

  const jid = `91${national}@s.whatsapp.net`;
  await recordLive({
    accountId, jid, providerMessageId: `tl-in-${stamp}`, fromMe: false,
    timestamp: new Date(), text: 'Please arrange a visit.',
    raw: { key: { id: `tl-in-${stamp}` } } as never,
  });
  await recordLive({
    accountId, jid, providerMessageId: `tl-out-${stamp}`, fromMe: true,
    timestamp: new Date(), text: 'Sharing property details.',
    raw: { key: { id: `tl-out-${stamp}` } } as never,
  });
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_wa_account WHERE id = $1`, [accountId]).catch(() => undefined);
  await db.query(`DELETE FROM ipy_record WHERE id = $1`, [leadId]).catch(() => undefined);
});

describe('WhatsApp on the timeline', () => {
  it('appears in the feed the CRM already had, not a second one', async () => {
    const entries = await buildTimeline(leadId, { limit: 50 });
    const bodies = entries.map((e) => e.body);
    expect(bodies).toContain('Please arrange a visit.');
    expect(bodies).toContain('Sharing property details.');
  });

  it('says who sent it, and from which number', async () => {
    const entries = await buildTimeline(leadId, { limit: 50 });
    const sent = entries.find((e) => e.body === 'Sharing property details.')!;

    expect(sent.actorName).toBe(agentName);
    expect(sent.title).toContain('Sent WhatsApp');
    // The number the customer actually saw.
    expect(sent.title).toContain('+9193');
    expect((sent.meta as { sentVia?: string }).sentVia).toContain('+9193');
  });

  it('attributes an incoming message to the customer, on the agent"s number', async () => {
    const entries = await buildTimeline(leadId, { limit: 50 });
    const received = entries.find((e) => e.body === 'Please arrange a visit.')!;

    // The customer said it; the agent's phone is where it landed. Both facts
    // matter on a record several people can read.
    expect(received.actorName).toBe('Customer');
    expect(received.title).toContain('Received WhatsApp');
    expect(received.title).toContain('+9193');
  });

  it('leaves a message with no linked account reading exactly as it used to', async () => {
    /*
      Every conversation kept back from the removal has no account — they
      predate agent linking. Those entries must not grow a stray "via" or an
      empty bracket where the number would be.
    */
    const conversation = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_conversation (channel, handle, record_id, record_module)
       VALUES ('sms', $1, $2, 'leads') RETURNING id`,
      [`+9192${stamp % 100000000}`, leadId],
    );
    await db.query(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status)
       VALUES ($1, 'outbound', 'sms', 'text', 'Old style message', 'sent')`,
      [conversation!.id],
    );

    const entry = (await buildTimeline(leadId, { limit: 50 })).find((e) => e.body === 'Old style message')!;
    expect(entry.title).toBe('Sent sms');
    expect((entry.meta as { sentVia?: string | null }).sentVia).toBeNull();
  });
});
