/**
 * Sending a unit to a buyer from inside the chat, and chasing them afterwards.
 *
 * Four things only a real database and the real permission layers can answer:
 *
 *  * the message says something a buyer can act on, and it **still says
 *    something** when the property has almost no facts filled in — which is
 *    what both live properties look like today, priced 0 with no size;
 *  * a link is minted per buyer and labelled with who it went to, because an
 *    unlabelled list of eleven links with view counts is one nobody can read
 *    a month later;
 *  * **a send that fails leaves no live link behind.** This is the one worth
 *    the test: outside WhatsApp's 24-hour window a free-text message cannot
 *    go, so the failure path is the ordinary path, and without the cleanup
 *    every refused attempt would leave a working link to a draft floor;
 *  * a rep who cannot open the property cannot send it, decided by
 *    `recordService` rather than by a second rule written here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { resolveShareToken } from '../../src/core/sharing/shareLinks.js';
import {
  assertFollowUpDay, contactBehind, shareMessage, sharePropertyOnWhatsApp,
} from '../../src/integrations/whatsapp/business/share.js';
import { adminContext, propertyInput } from './fixtures.js';

const stamp = Date.now();
const HANDLE = `9333${String(stamp).slice(-6)}`;

let ctx: Awaited<ReturnType<typeof adminContext>>;
let contactId = '';
let propertyId = '';
let conversationId = '';

beforeAll(async () => {
  ctx = await adminContext();

  const contact = await recordService.createRecord(ctx, 'leads', {
    full_name: `Share Buyer ${stamp}`,
    mobile: HANDLE,
    status: 'New',
  });
  contactId = contact.id;

  const property = await recordService.createRecord(
    ctx, 'properties', propertyInput({ full_name: `Share Unit ${stamp}` }),
  );
  propertyId = property.id;

  const conversation = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, record_id, record_module)
     VALUES ('whatsapp', $1, $2, 'leads') RETURNING id`,
    [HANDLE, contactId],
  );
  conversationId = conversation!.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_conversation WHERE handle = $1`, [HANDLE]);
  for (const id of [contactId, propertyId]) {
    if (id) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [id]).catch(() => undefined);
  }
});

describe('what the buyer reads', () => {
  it('leads with the unit and ends with the link', () => {
    const text = shareMessage({
      propertyLabel: 'B-110, Greenfield Colony',
      facts: { Configuration: '4 BHK', Locality: 'Greenfield Colony', Price: '₹1.45 Cr', Builder: 'Nobody' },
      url: 'https://crm.ipropy.com/s/abc123',
      note: 'Saw this and thought of you',
    });
    const lines = text.split('\n');

    expect(lines[0]).toBe('Saw this and thought of you');
    expect(lines[1]).toBe('B-110, Greenfield Colony');
    expect(text).toContain('Configuration: 4 BHK');
    expect(text).toContain('Price: ₹1.45 Cr');
    // Not a brochure: a fact nobody decides on is left out.
    expect(text).not.toContain('Builder');
    // The link last and alone, or WhatsApp does not preview it and nobody taps
    // a URL buried mid-sentence.
    expect(lines[lines.length - 1]).toBe('https://crm.ipropy.com/s/abc123');
  });

  it('still says something when nothing has been filled in', () => {
    // Both live properties are priced 0 with no size, and `propertyFacts`
    // drops a zero price rather than printing "₹0". So this is the real shape,
    // not an edge case.
    const text = shareMessage({ propertyLabel: 'B-110', facts: {}, url: 'https://x.test/s/t' });
    expect(text).toBe('B-110\nhttps://x.test/s/t');
  });
});

describe('sending it', () => {
  it('leaves no live link behind when the send fails', async () => {
    /*
      No provider is switched on in this database, so `sendOnBusinessNumber`
      refuses before anything reaches a customer — the same refusal a rep gets
      outside the 24-hour window, which is the common case. What must not
      survive it is the link.
    */
    await expect(sharePropertyOnWhatsApp({
      ctx,
      userId: ctx.user.id,
      to: HANDLE,
      contactId,
      propertyId,
      note: 'have a look',
    })).rejects.toThrow();

    const links = await db.query<{ id: string; token: string; label: string; revoked_at: string | null }>(
      `SELECT id, token, label, revoked_at FROM ipy_share_link WHERE record_id = $1`,
      [propertyId],
    );
    expect(links.rows, 'the link was never minted, so the cleanup proves nothing').toHaveLength(1);
    expect(links.rows[0]!.revoked_at, 'a failed send left a working link to a draft property')
      .not.toBeNull();
    // And it really is unusable, by the same path the public page uses.
    expect(await resolveShareToken(links.rows[0]!.token)).toBeNull();
  });

  it('labels the link with who it was for', async () => {
    const row = await db.queryOne<{ label: string }>(
      `SELECT label FROM ipy_share_link WHERE record_id = $1`, [propertyId],
    );
    expect(row?.label).toContain('WhatsApp');
    expect(row?.label).toContain(`Share Buyer ${stamp}`);
  });

  it('refuses a property the sender cannot open', async () => {
    await expect(sharePropertyOnWhatsApp({
      ctx,
      userId: ctx.user.id,
      to: HANDLE,
      contactId,
      propertyId: '11111111-1111-1111-1111-111111111111',
    })).rejects.toThrow();
  });
});

describe('chasing them afterwards', () => {
  it('refuses a day that has already been', () => {
    expect(() => assertFollowUpDay('2020-01-01')).toThrow(/cannot be in the past/);
    expect(() => assertFollowUpDay('tomorrow')).toThrow(/not a date/);
    // Today is allowed: "chase them later today" is a real thing to mean.
    expect(() => assertFollowUpDay(new Date().toISOString().slice(0, 10))).not.toThrow();
  });

  it('knows which contact a thread belongs to, and when there is none', async () => {
    expect(await contactBehind(conversationId)).toMatchObject({ id: contactId, module: 'leads' });

    const orphan = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_conversation (channel, handle) VALUES ('whatsapp', $1) RETURNING id`,
      [`9334${String(stamp).slice(-6)}`],
    );
    // A number nobody has claimed has no record to put a date on, and the
    // route says so rather than silently doing nothing.
    expect(await contactBehind(orphan!.id)).toBeNull();
    await db.query(`DELETE FROM ipy_conversation WHERE id = $1`, [orphan!.id]);
  });
});
