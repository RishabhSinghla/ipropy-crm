/**
 * Where the team is, and the two things this feature must never get wrong.
 *
 * **It must be off until somebody switches it on**, and it must stay off for a
 * phone still sending on an old build. A CRM that quietly begins recording
 * staff movements because a feature shipped is not a thing to have written.
 *
 * **A rep must never see a colleague they cannot already see.** Visibility
 * follows the role hierarchy exactly as records do; the moment this grows its
 * own answer to "who may look", it becomes the one part of the CRM with its own
 * rules, and that is how a leak gets built.
 *
 * The rest — accuracy, battery, which property somebody is standing at — is
 * detail. These two are the feature.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  currentPolicy, invalidateLocationSettings, locationSettings, metresBetween,
  pruneOldLocations, recordFixes, teamPositions, trail,
} from '../../src/core/locations/index.js';
import { createRecord, type ServiceContext } from '../../src/core/entity/recordService.js';
import { db } from '../../src/db/pool.js';
import { adminContext, authUser, contextFor, SEEDED } from './fixtures.js';
import type { AuthUser } from '@ipropy/shared';

let admin: ServiceContext;
let executiveA: ServiceContext;
let executiveB: ServiceContext;
let adminUser: AuthUser;
let executiveAUser: AuthUser;

/** Greenfield Colony, Faridabad. Real enough for the maths to mean something. */
const SITE: [number, number] = [28.4089, 77.3178];

const unique = (): string => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function setEnabled(on: boolean): Promise<void> {
  await db.query(
    `INSERT INTO ipy_setting (key, value, category) VALUES ('team_location.enabled', $1::jsonb, 'team_location')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(on)],
  );
  invalidateLocationSettings();
}

beforeAll(async () => {
  admin = await adminContext();
  executiveA = await contextFor(SEEDED.executiveA);
  executiveB = await contextFor(SEEDED.executiveB);
  adminUser = await authUser('admin@ipropy.com').catch(() => admin.user);
  executiveAUser = await authUser(SEEDED.executiveA);
});

beforeEach(async () => {
  await db.query(`DELETE FROM ipy_device_location`);
  await setEnabled(true);
});

describe('the switch', () => {
  it('stores nothing at all while it is off', async () => {
    await setEnabled(false);
    const result = await recordFixes(executiveAUser.id, null, [{
      latitude: SITE[0], longitude: SITE[1], recordedAt: Date.now(),
    }]);
    expect(result.stored).toBe(0);
    // A reason rather than silence, so a handset on an old build learns to stop
    // instead of retrying for ever.
    expect(result.reason).toMatch(/switched off/i);

    const rows = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_device_location`);
    expect(Number(rows?.n)).toBe(0);
  });

  it('tells the phone it is off, so the phone stops asking', async () => {
    await setEnabled(false);
    const policy = await currentPolicy();
    expect(policy.enabled).toBe(false);
    expect(policy.withinHours).toBe(false);
  });

  it('never asks for a reading faster than Android will wake the app', async () => {
    // WorkManager refuses a periodic job under fifteen minutes. A setting that
    // promised ten would be a promise the phone cannot keep.
    await db.query(
      `INSERT INTO ipy_setting (key, value, category) VALUES ('team_location.every_minutes','2'::jsonb,'team_location')
       ON CONFLICT (key) DO UPDATE SET value = '2'::jsonb`,
    );
    invalidateLocationSettings();
    try {
      expect((await locationSettings()).everyMinutes).toBe(15);
    } finally {
      await db.query(`UPDATE ipy_setting SET value = '15'::jsonb WHERE key = 'team_location.every_minutes'`);
      invalidateLocationSettings();
    }
  });
});

describe('who can see whom', () => {
  it('shows an admin everybody', async () => {
    await recordFixes(executiveAUser.id, null, [{
      latitude: SITE[0], longitude: SITE[1], recordedAt: Date.now(),
    }]);
    const seen = await teamPositions(adminUser);
    expect(seen.map((p) => p.userId)).toContain(executiveAUser.id);
  });

  it('does not show one executive another', async () => {
    const otherUser = executiveB.user;
    await recordFixes(otherUser.id, null, [{
      latitude: SITE[0], longitude: SITE[1], recordedAt: Date.now(),
    }]);

    const seen = await teamPositions(executiveAUser);
    expect(seen.map((p) => p.userId)).not.toContain(otherUser.id);
  });

  it('refuses a trail for somebody out of view', async () => {
    const otherUser = executiveB.user;
    await recordFixes(otherUser.id, null, [{
      latitude: SITE[0], longitude: SITE[1], recordedAt: Date.now(),
    }]);
    expect(await trail(executiveAUser, otherUser.id, 12)).toEqual([]);
    // And their own is fine.
    await recordFixes(executiveAUser.id, null, [{
      latitude: SITE[0], longitude: SITE[1], recordedAt: Date.now(),
    }]);
    expect((await trail(executiveAUser, executiveAUser.id, 12)).length).toBeGreaterThan(0);
  });
});

describe('reading a position', () => {
  it('keeps only the newest fix per person', async () => {
    const now = Date.now();
    await recordFixes(executiveAUser.id, null, [
      { latitude: 28.40, longitude: 77.31, recordedAt: now - 60 * 60_000 },
      { latitude: 28.41, longitude: 77.32, recordedAt: now - 60_000 },
    ]);
    const seen = await teamPositions(adminUser);
    const mine = seen.filter((p) => p.userId === executiveAUser.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.latitude).toBeCloseTo(28.41, 2);
  });

  it('refuses a fix from the future or from years ago', async () => {
    const result = await recordFixes(executiveAUser.id, null, [
      { latitude: 28.4, longitude: 77.3, recordedAt: Date.now() + 60 * 60_000 },
      { latitude: 28.4, longitude: 77.3, recordedAt: Date.now() - 400 * 24 * 60 * 60_000 },
      { latitude: 999, longitude: 77.3, recordedAt: Date.now() },
    ]);
    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it('says which property somebody is standing at', async () => {
    const property = await createRecord(admin, 'properties', {
      name: `Site ${unique()}`,
      latitude: SITE[0],
      longitude: SITE[1],
    });
    // 60 metres away, well inside the default 150 metre radius.
    await recordFixes(executiveAUser.id, null, [{
      latitude: SITE[0] + 0.00054, longitude: SITE[1], recordedAt: Date.now(),
    }]);

    const mine = (await teamPositions(adminUser)).find((p) => p.userId === executiveAUser.id);
    expect(mine?.atProperty?.id).toBe(property.id);
    // The distance travels with the match, so nobody reads a dot as certainty
    // about which of two adjacent floors somebody walked into.
    expect(mine?.atProperty?.metres).toBeGreaterThan(30);
    expect(mine?.atProperty?.metres).toBeLessThan(120);
  });

  it('claims nothing when the nearest property is far away', async () => {
    await createRecord(admin, 'properties', {
      name: `Far ${unique()}`, latitude: SITE[0], longitude: SITE[1],
    });
    // About 5 km north.
    await recordFixes(executiveAUser.id, null, [{
      latitude: SITE[0] + 0.045, longitude: SITE[1], recordedAt: Date.now(),
    }]);
    const mine = (await teamPositions(adminUser)).find((p) => p.userId === executiveAUser.id);
    expect(mine?.atProperty).toBeNull();
  });
});

describe('forgetting', () => {
  it('deletes points older than the retention setting', async () => {
    await recordFixes(executiveAUser.id, null, [{
      latitude: SITE[0], longitude: SITE[1], recordedAt: Date.now(),
    }]);
    // Age one row past any plausible retention.
    await db.query(
      `UPDATE ipy_device_location SET recorded_at = now() - interval '400 days' WHERE user_id = $1`,
      [executiveAUser.id],
    );
    expect(await pruneOldLocations()).toBeGreaterThan(0);
    const rows = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_device_location`);
    expect(Number(rows?.n)).toBe(0);
  });
});

describe('the distance maths', () => {
  it('measures a short hop the way a tape measure would', () => {
    // One ten-thousandth of a degree of latitude is about 11 metres anywhere.
    expect(metresBetween(28.4089, 77.3178, 28.4090, 77.3178)).toBeCloseTo(11.1, 0);
  });

  it('is zero for the same point', () => {
    expect(metresBetween(SITE[0], SITE[1], SITE[0], SITE[1])).toBe(0);
  });
});
