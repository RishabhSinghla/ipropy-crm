/**
 * Calls, end to end.
 *
 * The existing suite proves a phone can pair and that a repeated sync
 * deduplicates. What nobody had checked is the part the feature exists for:
 * that a call made on somebody's own handset finds the right lead and moves them
 * along. A sync that stores rows nobody can connect to a person is not call
 * tracking, it is a phone bill.
 *
 * Written against the service rather than the HTTP routes on purpose — the
 * routes are covered in api.test.ts, and the matching rules are where the
 * behaviour lives.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../../src/db/pool.js';
import { pairDevice, syncCalls, type AuthedDevice } from '../../src/integrations/telephony/deviceSync.js';
import { logManualCall } from '../../src/integrations/telephony/service.js';
import { createRecord } from '../../src/core/entity/recordService.js';
import { adminContext, leadInput } from './fixtures.js';

/**
 * A number written the way an agent's phone would store it, unique to this run.
 *
 * Not a fixed one: another suite syncs `+919812345678` too, and a test that
 * asserts on "every call to this number" then picks up somebody else's row. The
 * e2e specs use unique markers for the same reason.
 */
const MOBILE = `98${String(Date.now()).slice(-8)}`;

let device: AuthedDevice;
let leadId = '';

async function leadRow(): Promise<{
  last_contacted_at: string | Date | null; contact_attempts: number; status: string;
}> {
  // Not typed as Date: db/pool.ts registers a parser that leaves `date` columns
  // as strings, so what comes back depends on the column type rather than on
  // anything this test controls.
  const row = await db.queryOne<{ last_contacted_at: string | Date | null; contact_attempts: number; status: string }>(
    `SELECT last_contacted_at, contact_attempts, status FROM ipy_e_leads WHERE record_id = $1`,
    [leadId],
  );
  return row!;
}

async function callsFor(number: string): Promise<{ record_id: string | null; direction: string; duration_seconds: number }[]> {
  const res = await db.query<{ record_id: string | null; direction: string; duration_seconds: number }>(
    `SELECT record_id, direction, duration_seconds FROM ipy_call
      WHERE right(regexp_replace(from_number,'\\D','','g'), 10) = $1
         OR right(regexp_replace(to_number,'\\D','','g'), 10) = $1
      ORDER BY started_at`,
    [number.slice(-10)],
  );
  return res.rows;
}

beforeAll(async () => {
  const admin = await adminContext();
  const lead = await createRecord(admin, 'leads', leadInput({
    full_name: 'Telephony Test Lead',
    mobile: MOBILE,
    status: 'New',
  }));
  leadId = lead.id;

  const paired = await pairDevice({
    userId: admin.user.id,
    label: 'Test handset',
    phoneNumber: '+919800000009',
    model: 'Pixel',
  });
  device = { id: paired.deviceId, userId: admin.user.id, phoneNumber: '+919800000009' };
});

describe('a call from an agent handset', () => {
  it('finds the lead however the number was written on the phone', async () => {
    // The same person, three ways a phone stores a number. All of them have to
    // land on one lead or the CRM shows three strangers.
    const forms = [`+91${MOBILE}`, `0${MOBILE}`, `${MOBILE.slice(0, 5)} ${MOBILE.slice(5)}`];

    for (const [index, number] of forms.entries()) {
      const result = await syncCalls(device, [{
        externalId: `match-${index}-${Date.now()}`,
        number,
        type: 2, // outgoing
        timestamp: Date.now() - (index + 1) * 60_000,
        durationSeconds: 45,
        contactName: null,
      }]);
      expect(result, `${number} should have matched`).toMatchObject({ created: 1, matched: 1 });
    }

    const calls = await callsFor(MOBILE);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.record_id === leadId)).toBe(true);
  });

  it('moves the lead along: last contacted, attempts, and New becomes Contacted', async () => {
    // This is the whole point of syncing calls at all.
    const after = await leadRow();
    expect(after.status).toBe('Contacted');
    expect(after.contact_attempts).toBeGreaterThanOrEqual(3);
    expect(after.last_contacted_at).not.toBeNull();
  });

  it('counts a missed call as an attempt without claiming contact', async () => {
    const before = await leadRow();
    await syncCalls(device, [{
      externalId: `missed-${Date.now()}`,
      number: MOBILE,
      type: 3, // missed
      timestamp: Date.now(),
      durationSeconds: 0,
      contactName: null,
    }]);

    const after = await leadRow();
    expect(after.contact_attempts).toBe(before.contact_attempts + 1);
    // A missed call must not move last_contacted_at — that field drives the
    // follow-up chase, and nobody was actually spoken to.
    expect(String(after.last_contacted_at)).toBe(String(before.last_contacted_at));
  });

  it('stores a call from a number nobody in the CRM has', async () => {
    const stranger = '9700000123';
    const result = await syncCalls(device, [{
      externalId: `stranger-${Date.now()}`,
      number: stranger,
      type: 1, // incoming
      timestamp: Date.now(),
      durationSeconds: 30,
      contactName: 'Unknown',
    }]);

    expect(result).toMatchObject({ created: 1, matched: 0 });
    const calls = await callsFor(stranger);
    expect(calls[0].record_id).toBeNull();
  });

  it('ignores the same call arriving again, however many times the phone resends it', async () => {
    // The app resyncs every 15 minutes and the window overlaps, so this is
    // normal traffic rather than an edge case.
    const entry = {
      externalId: `stable-id-${Date.now()}`,
      number: MOBILE,
      type: 2,
      timestamp: Date.now(),
      durationSeconds: 12,
      contactName: null,
    };

    expect(await syncCalls(device, [entry])).toMatchObject({ created: 1, duplicates: 0 });
    expect(await syncCalls(device, [entry])).toMatchObject({ created: 0, duplicates: 1 });
    expect(await syncCalls(device, [entry, entry])).toMatchObject({ created: 0, duplicates: 2 });
  });

  it('takes a batch the way a phone that was offline for a day would send one', async () => {
    const batch = Array.from({ length: 25 }, (_, i) => ({
      externalId: `batch-${Date.now()}-${i}`,
      number: MOBILE,
      type: 2,
      timestamp: Date.now() - i * 3_600_000,
      durationSeconds: 30 + i,
      contactName: null,
    }));

    const result = await syncCalls(device, batch);
    expect(result).toMatchObject({ received: 25, created: 25, matched: 25 });
  });
});

describe('a call logged by hand', () => {
  it('records the duration and the disposition, and links the lead', async () => {
    // The path that returned a 500 until this session: the duration was read
    // twice in one statement, once as a number and once as text.
    const { callId } = await logManualCall({
      userId: device.userId,
      recordId: leadId,
      module: 'leads',
      toNumber: MOBILE,
      direction: 'outbound',
      durationSeconds: 300,
      disposition: 'Interested',
      notes: 'Wants a site visit on Saturday',
    });

    const call = await db.queryOne<{
      duration_seconds: number; disposition: string; source: string;
      record_id: string; started_at: Date; ended_at: Date;
    }>(`SELECT duration_seconds, disposition, source, record_id, started_at, ended_at FROM ipy_call WHERE id = $1`, [callId]);

    expect(call).toMatchObject({
      duration_seconds: 300, disposition: 'Interested', source: 'manual', record_id: leadId,
    });
    // started_at is derived from the duration, so a wrong sign or unit shows up here.
    const spanSeconds = (call!.ended_at.getTime() - call!.started_at.getTime()) / 1000;
    expect(Math.round(spanSeconds)).toBe(300);
  });

  it('accepts a call with no lead attached', async () => {
    const { callId } = await logManualCall({
      userId: device.userId,
      recordId: null,
      module: null,
      toNumber: '9700000456',
      direction: 'inbound',
      durationSeconds: 0,
    });
    expect(callId).toBeTruthy();
  });
});
