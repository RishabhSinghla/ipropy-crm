/**
 * A unit put on hold has to say when the hold ends.
 *
 * "Release expired blocks" runs hourly on the condition
 * `blocked_until older_than_n_days 0`. A blank date is never older than
 * anything, so a hold with no expiry is never released. The unit stops being
 * Available, drops out of buyer matching, the first reply, lead scoring and the
 * public website, and nothing anywhere reports it. It leaves the market and does
 * not come back.
 *
 * Broadening the release job would be the wrong fix — it would free every blank
 * hold at the next tick, including one a rep set deliberately ten minutes ago.
 * The date is required at the moment it matters instead.
 *
 * `isMandatory` could not express that: required always would block every
 * property that is not on hold, which is nearly all of them. `requiredWhen`
 * carries a condition in the same filter grammar the rest of the CRM uses, so
 * an admin can see and change it, and the same mechanism now serves any other
 * rule of that shape — a reason on a Lost lead, a value on a Won one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, propertyInput } from './fixtures.js';

const made: string[] = [];
let seq = 0;

beforeAll(async () => { await registry.warmup(); });

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

async function addProperty(values: Record<string, unknown> = {}) {
  const p = await recordService.createRecord(await adminContext(), 'properties', propertyInput({
    full_name: `Hold Test ${++seq}`, locality: 'Sector 78', floor: seq,
    status: 'Available', property_type: 'Builder Floor', ...values,
  }));
  made.push(p.id);
  return p;
}

const inAWeek = () => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

describe('putting a unit on hold', () => {
  it('refuses a hold with no end date', async () => {
    const p = await addProperty();
    await expect(
      recordService.updateRecord(await adminContext(), 'properties', p.id, { status: 'Held' }),
    ).rejects.toThrow(/blocked until|required/i);
  });

  it('accepts a hold that says when it ends', async () => {
    const p = await addProperty();
    const held = await recordService.updateRecord(await adminContext(), 'properties', p.id, {
      status: 'Held', blocked_until: inAWeek(),
    });
    expect(held.id).toBe(p.id);
  });

  it('leaves every other status alone', async () => {
    /*
      The rule must bite only on hold. A property that is Available, Sold or
      Withdrawn has no business being asked for a hold expiry, and requiring it
      everywhere is what marking the field mandatory would have done.
    */
    for (const status of ['Available', 'Sold', 'Not For Sale']) {
      const p = await addProperty();
      const saved = await recordService.updateRecord(await adminContext(), 'properties', p.id, { status });
      expect(saved.id, `${status} should not need a hold expiry`).toBe(p.id);
    }
  });

  it('does not block an edit to a held unit that already has a date', async () => {
    // Changing the price of a unit already on hold must not be refused for
    // failing to re-send a date that is already stored.
    const p = await addProperty({ status: 'Held', blocked_until: inAWeek() });
    const saved = await recordService.updateRecord(await adminContext(), 'properties', p.id, {
      base_price: 14500000,
    });
    expect(saved.id).toBe(p.id);
  });

  it('drains a unit that was already stuck', async () => {
    /*
      The migration gave the existing backlog a week so it leaves through the
      ordinary release job. Asserted on a row this test creates rather than on a
      count across the database — other specs write here too, and a global count
      would be testing them.
    */
    const p = await addProperty({ status: 'Held', blocked_until: inAWeek() });
    await db.query(
      `UPDATE ipy_e_properties SET blocked_until = NULL WHERE record_id = $1`, [p.id],
    );
    await db.query(
      `UPDATE ipy_e_properties SET blocked_until = (now() + interval '7 days')::date
        WHERE status IN ('Held','Blocked') AND blocked_until IS NULL AND record_id = $1`,
      [p.id],
    );
    const row = await db.queryOne<{ blocked_until: string | null }>(
      `SELECT blocked_until FROM ipy_e_properties WHERE record_id = $1`, [p.id],
    );
    expect(row?.blocked_until, 'a hold with no end date never reaches the release job').toBeTruthy();
  });
});

describe('the rule is metadata', () => {
  it('is a condition an admin can read, not code', async () => {
    const module = await registry.requireModule('properties');
    const field = module.fields.find((f) => f.name === 'blocked_until');
    expect(field?.config.requiredWhen).toBeTruthy();
    expect(field?.isMandatory, 'required always would block every ordinary property').toBe(false);
  });
});

describe('the price with charges', () => {
  it('is no longer called all-inclusive, because it is not', async () => {
    /*
      The formula is base price plus the six charge fields. GST, stamp duty and
      registration are not in it, and all three sit on the same form directly
      above the total. The label was a false statement rather than a vague one.
    */
    const module = await registry.requireModule('properties');
    const field = module.fields.find((f) => f.name === 'total_price');
    expect(field?.label).not.toMatch(/all.?inclusive/i);
  });

  it('still computes exactly what it did before', async () => {
    // The label changed and the formula did not, deliberately: this number is
    // the advertised price on the website, every share link and the WhatsApp
    // summary, and changing it would move all of them at once.
    const module = await registry.requireModule('properties');
    const field = module.fields.find((f) => f.name === 'total_price');
    const expr = String((field?.config.formula as { expression?: string } | undefined)?.expression ?? '');
    expect(expr).toContain('{base_price}');
    expect(expr).not.toContain('gst');
    expect(expr).not.toContain('stamp_duty');
  });
});
