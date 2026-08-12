/**
 * Shoot sessions — the record that binds a property to a window of time.
 *
 * The cases that matter are the awkward ones, because the phone is offline at
 * the gate and honest about it later: requests arrive out of order, arrive
 * twice, and arrive hours after the tap that produced them. A session layer
 * that only works when the network does would file the whole day's photos
 * against whichever property happened to sync last.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/pool.js';
import {
  assignSessionRecord, closeStaleSessions, currentSession, listSessions,
  openSession, sessionForCapture, SESSION_IDLE_MINUTES,
} from '../../src/core/capture/sessions.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { registry } from '../../src/core/metadata/registry.js';
import { adminContext, authUser, SEEDED } from './fixtures.js';

const minutes = (n: number): number => n * 60_000;

describe('capture sessions', () => {
  let userId: string;

  beforeEach(async () => {
    // A fresh user per test: sessions are per-user and the close-the-previous
    // rule would otherwise make these interfere with each other.
    const user = await authUser(SEEDED.executiveA);
    userId = user.id;
    await db.query(`DELETE FROM ipy_shoot_session WHERE user_id = $1`, [userId]);
  });

  it('opens a session and reports it as the current one', async () => {
    const s = await openSession({ userId, clientRef: randomUUID(), lat: 28.4089, lng: 77.3178, accuracyM: 8.5 });

    expect(s.status).toBe('capturing');
    expect(s.endedAt).toBeNull();
    expect(s.lat).toBeCloseTo(28.4089, 4);
    expect(s.accuracyM).toBeCloseTo(8.5, 1);
    expect((await currentSession(userId))?.id).toBe(s.id);
  });

  it('still closes the previous visit when Finish was forgotten', async () => {
    const first = await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(40)) });
    const second = await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(10)) });

    const closed = await db.queryOne<{ ended_at: Date; status: string }>(
      `SELECT ended_at, status FROM ipy_shoot_session WHERE id = $1`, [first.id],
    );
    expect(closed?.ended_at).not.toBeNull();
    expect(closed?.status).toBe('ready');
    expect((await currentSession(userId))?.id).toBe(second.id);
  });

  it('is idempotent, because the offline queue retries', async () => {
    // The device may retry a request that already succeeded but whose response
    // never arrived. Asking twice must not produce two visits.
    const ref = randomUUID();
    const a = await openSession({ userId, clientRef: ref });
    const b = await openSession({ userId, clientRef: ref });

    expect(b.id).toBe(a.id);
    const { rows } = await db.query(`SELECT id FROM ipy_shoot_session WHERE user_id = $1`, [userId]);
    expect(rows.length).toBe(1);
  });

  it('a retry does not re-close the session that followed it', async () => {
    // The nasty ordering: visit A syncs, visit B syncs, then A is retried. If
    // the retry took the create path it would close B and B would stop
    // collecting the photos still arriving for it.
    const refA = randomUUID();
    await openSession({ userId, clientRef: refA, startedAt: new Date(Date.now() - minutes(60)) });
    const b = await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(20)) });

    await openSession({ userId, clientRef: refA, startedAt: new Date(Date.now() - minutes(60)) });

    expect((await currentSession(userId))?.id).toBe(b.id);
  });

  it('closes the previous visit at the new one\'s start, not at now', async () => {
    // A request that sat in the queue for hours must not stretch the previous
    // session across the visit that came after it.
    const start = new Date(Date.now() - minutes(120));
    await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(180)) });
    await openSession({ userId, clientRef: randomUUID(), startedAt: start });

    const first = await db.queryOne<{ ended_at: Date }>(
      `SELECT ended_at FROM ipy_shoot_session WHERE user_id = $1 ORDER BY started_at LIMIT 1`, [userId],
    );
    expect(first!.ended_at.getTime()).toBe(start.getTime());
  });

  it('never produces a window that ends before it starts', async () => {
    // An out-of-order sync: a tap from *before* the currently open session
    // arrives late. ended_at < started_at would make the range match nothing.
    const open = await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(10)) });
    await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(50)) });

    const row = await db.queryOne<{ started_at: Date; ended_at: Date }>(
      `SELECT started_at, ended_at FROM ipy_shoot_session WHERE id = $1`, [open.id],
    );
    expect(row!.ended_at.getTime()).toBeGreaterThanOrEqual(row!.started_at.getTime());
  });

  describe('matching a photo to a visit', () => {
    it('files a photo by when it was taken, not when it uploaded', async () => {
      const morning = await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(300)) });
      const afternoon = await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(120)) });

      // Both uploaded this evening; only the shutter times differ.
      const atMorning = await sessionForCapture(userId, new Date(Date.now() - minutes(280)));
      const atAfternoon = await sessionForCapture(userId, new Date(Date.now() - minutes(100)));

      expect(atMorning?.id).toBe(morning.id);
      expect(atAfternoon?.id).toBe(afternoon.id);
    });

    it('attaches to the visit in progress without waiting for it to close', async () => {
      const open = await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(5)) });
      expect((await sessionForCapture(userId, new Date()))?.id).toBe(open.id);
    });

    it('returns nothing for a photo taken before any visit', async () => {
      await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(30)) });
      expect(await sessionForCapture(userId, new Date(Date.now() - minutes(600)))).toBeNull();
    });

    it('does not match another person\'s visit', async () => {
      await openSession({ userId, clientRef: randomUUID(), startedAt: new Date(Date.now() - minutes(30)) });
      const other = await authUser(SEEDED.executiveB);
      expect(await sessionForCapture(other.id, new Date())).toBeNull();
    });
  });

  it('closes the day\'s last visit, which has no successor to close it', async () => {
    await openSession({
      userId, clientRef: randomUUID(),
      startedAt: new Date(Date.now() - minutes(SESSION_IDLE_MINUTES + 30)),
    });
    const fresh = await openSession({ userId, clientRef: randomUUID() });

    await closeStaleSessions();

    // The stale one is closed; the one still in progress is untouched.
    const { rows } = await db.query<{ id: string; ended_at: Date | null }>(
      `SELECT id, ended_at FROM ipy_shoot_session WHERE user_id = $1 ORDER BY started_at`, [userId],
    );
    expect(rows[0].ended_at).not.toBeNull();
    expect(rows.find((r) => r.id === fresh.id)!.ended_at).toBeNull();
  });

  it('takes the property record after the fact, for the offline case', async () => {
    // At the gate there is no signal and no record yet; both appear on sync.
    const ctx = await adminContext();
    await registry.requireModule('properties');
    const session = await openSession({ userId, clientRef: randomUUID() });
    expect(session.recordId).toBeNull();

    const property = await recordService.createRecord(ctx, 'properties', { name: 'B-110 Greenfield' });
    const linked = await assignSessionRecord(session.id, property.id);

    expect(linked?.recordId).toBe(property.id);
    const listed = await listSessions(userId);
    expect(listed[0].recordLabel).toContain('B-110 Greenfield');
    expect(listed[0].mediaCount).toBe(0);
  });
});
