/**
 * Grouping a day's loose photos into the shoots they came from.
 *
 * This is the path for somebody who photographed six builder floors and tapped
 * nothing, which is the realistic case rather than the exceptional one. The
 * grouping is a guess, and the two ways a guess goes wrong are not symmetric:
 * an over-split day makes somebody name the same property twice and is obvious
 * on screen, while a merged day silently files one property's photos under
 * another's name and looks completely fine until a client is sent the wrong
 * kitchen. So most of what is asserted here is about boundaries holding.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import {
  GAP_MINUTES, SETTLE_MINUTES, groupUnfiledPhotos, listUnnamedShoots, nameShoot,
} from '../../src/core/capture/grouping.js';
import { matchOrphansForSession } from '../../src/core/capture/matching.js';
import { openSession } from '../../src/core/capture/sessions.js';
import { adminContext, authUser, SEEDED } from './fixtures.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';

const minutes = (n: number): number => n * 60_000;

/** Comfortably past the settle window, so a photo is eligible to be grouped. */
const settled = (minutesAgo: number): Date =>
  new Date(Date.now() - minutes(SETTLE_MINUTES + 30 + minutesAgo));

async function photo(userId: string, capturedAt: Date | null, recordId: string | null = null): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, uploaded_by, captured_at)
     VALUES ($1,'IMG.jpg','image/jpeg',10,$2,$3,$4) RETURNING id`,
    [recordId, `itest/${randomUUID()}.jpg`, userId, capturedAt],
  );
  return row!.id;
}

async function shootOf(attachmentId: string): Promise<string | null> {
  const row = await db.queryOne<{ shoot_session_id: string | null }>(
    `SELECT shoot_session_id FROM ipy_attachment WHERE id = $1`, [attachmentId],
  );
  return row?.shoot_session_id ?? null;
}

async function recordOf(attachmentId: string): Promise<string | null> {
  const row = await db.queryOne<{ record_id: string | null }>(
    `SELECT record_id FROM ipy_attachment WHERE id = $1`, [attachmentId],
  );
  return row?.record_id ?? null;
}

/**
 * Other suites deliberately leave attachments unfiled and sessions open, and
 * both would be swept up here — an open-ended session legitimately claims
 * anything after its start. These tests are about boundaries, so they have to
 * begin from nothing to be measuring what they think they are.
 */
async function resetFor(userId: string): Promise<void> {
  await db.query(`DELETE FROM ipy_attachment WHERE uploaded_by = $1`, [userId]);
  await db.query(`DELETE FROM ipy_shoot_session WHERE user_id = $1`, [userId]);
}

describe('grouping loose photos into shoots', () => {
  let ctx: ServiceContext;
  let userId: string;

  beforeAll(async () => {
    ctx = await adminContext();
    await registry.requireModule('properties');
    const admin = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
    );
    userId = admin!.id;
  });

  beforeEach(async () => {
    await resetFor(userId);
  });

  it('splits the day where the driving happened', async () => {
    // Two bursts an hour apart: one builder floor, a drive, another floor.
    const first = [await photo(userId, settled(300)), await photo(userId, settled(295))];
    const second = [await photo(userId, settled(200)), await photo(userId, settled(196))];

    expect(await groupUnfiledPhotos()).toBe(4);

    const a = await shootOf(first[0]!);
    const b = await shootOf(second[0]!);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(await shootOf(first[1]!)).toBe(a);
    expect(await shootOf(second[1]!)).toBe(b);
  });

  it('keeps one long walkthrough together despite quiet stretches', async () => {
    // A thorough visit is not a continuous burst — the photographer stops to
    // listen to the owner, measures a room, argues about the price. Splitting
    // on those pauses would make somebody name the same floor three times.
    const ids = [
      await photo(userId, settled(300)),
      await photo(userId, settled(280)),
      await photo(userId, settled(255)),
      await photo(userId, settled(240)),
    ];

    expect(await groupUnfiledPhotos()).toBe(4);

    const shoot = await shootOf(ids[0]!);
    expect(shoot).toBeTruthy();
    for (const id of ids) expect(await shootOf(id)).toBe(shoot);
  });

  it('splits at exactly one gap either side of the threshold', async () => {
    // The boundary itself, pinned: a gap under GAP_MINUTES holds together and a
    // gap over it separates. Asserted directly because the constant is the one
    // number in this feature somebody will want to tune later.
    const anchor = settled(400);
    const near = new Date(anchor.getTime() + minutes(GAP_MINUTES - 5));
    const far = new Date(near.getTime() + minutes(GAP_MINUTES + 5));

    const a = await photo(userId, anchor);
    const b = await photo(userId, near);
    const c = await photo(userId, far);

    await groupUnfiledPhotos();

    expect(await shootOf(b)).toBe(await shootOf(a));
    expect(await shootOf(c)).not.toBe(await shootOf(a));
  });

  it('leaves photos that only just arrived alone', async () => {
    // Uploads finish out of order and hours late. Grouping a photo the instant
    // it lands would mint a group per straggler.
    const fresh = await photo(userId, new Date(Date.now() - minutes(5)));
    expect(await groupUnfiledPhotos()).toBe(0);
    expect(await shootOf(fresh)).toBeNull();
  });

  it('ignores a photo with no capture time', async () => {
    // A screenshot, a WhatsApp forward. There is nothing to group it by, and
    // grouping it by upload time would attach it confidently and wrongly.
    const unknown = await photo(userId, null);
    await groupUnfiledPhotos();
    expect(await shootOf(unknown)).toBeNull();
  });

  it('never touches a photo somebody filed against a property by hand', async () => {
    // Uploaded from a property's own Files tab. Inferring a site visit for it
    // would be inventing a trip that never happened.
    const property = await recordService.createRecord(ctx, 'properties', { name: 'Deskbound Floor' });
    const filed = await photo(userId, settled(120), property.id);

    await groupUnfiledPhotos();

    expect(await shootOf(filed)).toBeNull();
    expect(await recordOf(filed)).toBe(property.id);
  });

  it('is safe to run twice', async () => {
    const ids = [await photo(userId, settled(300)), await photo(userId, settled(297))];

    expect(await groupUnfiledPhotos()).toBe(2);
    const shoot = await shootOf(ids[0]!);

    // A second sweep must find nothing left to do rather than build a rival
    // group beside the first.
    expect(await groupUnfiledPhotos()).toBe(0);
    expect(await shootOf(ids[0]!)).toBe(shoot);

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM ipy_shoot_session WHERE user_id = $1`, [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('lets a straggler join the group it belongs to', async () => {
    // The out-of-order case: the phone finishes uploading the middle of a burst
    // first. The photo that arrives late must widen its group rather than start
    // a competing one covering the same minutes.
    const early = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    const shoot = await shootOf(early);

    const straggler = await photo(userId, settled(290));
    expect(await groupUnfiledPhotos()).toBe(1);
    expect(await shootOf(straggler)).toBe(shoot);

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM ipy_shoot_session WHERE user_id = $1`, [userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('will not widen a group that has already been named', async () => {
    // Naming is a decision. A straggler arriving afterwards is not a reason to
    // stretch a settled shoot's window over the next property's photos.
    const early = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    const shoot = (await shootOf(early))!;

    const property = await recordService.createRecord(ctx, 'properties', { name: 'Settled Floor' });
    await nameShoot(shoot, userId, property.id);

    const straggler = await photo(userId, settled(295));
    await groupUnfiledPhotos();

    expect(await shootOf(straggler)).not.toBe(shoot);
  });

  it('keeps two people\'s days apart', async () => {
    const other = await authUser(SEEDED.executiveB);
    await resetFor(other.id);

    const mine = await photo(userId, settled(300));
    const theirs = await photo(other.id, settled(299));

    await groupUnfiledPhotos();

    expect(await shootOf(mine)).not.toBe(await shootOf(theirs));
    await resetFor(other.id);
  });
});

describe('naming a shoot', () => {
  let ctx: ServiceContext;
  let userId: string;

  beforeAll(async () => {
    ctx = await adminContext();
    const admin = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
    );
    userId = admin!.id;
  });

  beforeEach(async () => {
    await resetFor(userId);
  });

  it('gives the property to every photo in the shoot', async () => {
    // The regression this pins: the photos inside a shoot used to be the one
    // set naming could not reach. `matchAttachment` copies the session's
    // record_id onto a photo when it files it, which is null for a nameless
    // shoot, and the old orphan sweep only looked at photos with no session at
    // all. The visit read as named and the property's Files tab stayed empty.
    const ids = [await photo(userId, settled(300)), await photo(userId, settled(298))];
    await groupUnfiledPhotos();
    const shoot = (await shootOf(ids[0]!))!;

    const property = await recordService.createRecord(ctx, 'properties', { name: 'Named Floor' });
    const result = await nameShoot(shoot, userId, property.id);

    expect(result.ok).toBe(true);
    expect(result.photosAttached).toBe(2);
    for (const id of ids) expect(await recordOf(id)).toBe(property.id);
  });

  it('refuses a shoot that already has a property', async () => {
    // A stale screen re-submitting must not repoint a shoot somebody has since
    // named to something else.
    const id = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    const shoot = (await shootOf(id))!;

    const first = await recordService.createRecord(ctx, 'properties', { name: 'First Choice' });
    const second = await recordService.createRecord(ctx, 'properties', { name: 'Second Choice' });

    expect((await nameShoot(shoot, userId, first.id)).ok).toBe(true);
    expect((await nameShoot(shoot, userId, second.id)).ok).toBe(false);
    expect(await recordOf(id)).toBe(first.id);
  });

  it('refuses somebody else\'s shoot', async () => {
    const id = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    const shoot = (await shootOf(id))!;

    const other = await authUser(SEEDED.executiveB);
    const property = await recordService.createRecord(ctx, 'properties', { name: 'Not Yours' });

    expect((await nameShoot(shoot, other.id, property.id)).ok).toBe(false);
    expect(await recordOf(id)).toBeNull();
  });

  it('leaves a photo that was already filed by hand where it is', async () => {
    const chosen = await recordService.createRecord(ctx, 'properties', { name: 'Hand Filed' });
    const grouped = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    const shoot = (await shootOf(grouped))!;

    // Somebody moves one photo onto a different property before reviewing.
    await db.query(`UPDATE ipy_attachment SET record_id = $2 WHERE id = $1`, [grouped, chosen.id]);

    const property = await recordService.createRecord(ctx, 'properties', { name: 'Whole Shoot' });
    await nameShoot(shoot, userId, property.id);

    expect(await recordOf(grouped)).toBe(chosen.id);
  });
});

describe('the evening list', () => {
  let ctx: ServiceContext;
  let userId: string;

  beforeAll(async () => {
    ctx = await adminContext();
    const admin = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
    );
    userId = admin!.id;
  });

  beforeEach(async () => {
    await resetFor(userId);
  });

  it('shows a nameless shoot with its count and a few previews', async () => {
    for (let i = 0; i < 6; i += 1) await photo(userId, settled(300 - i));
    await groupUnfiledPhotos();

    const shoots = await listUnnamedShoots(userId);
    expect(shoots).toHaveLength(1);
    expect(shoots[0]!.mediaCount).toBe(6);
    expect(shoots[0]!.origin).toBe('auto');
    // Enough to recognise the place, not enough to make the list heavy.
    expect(shoots[0]!.previewIds).toHaveLength(4);
  });

  it('drops a shoot once it has been named', async () => {
    const id = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    expect(await listUnnamedShoots(userId)).toHaveLength(1);

    const property = await recordService.createRecord(ctx, 'properties', { name: 'Done Floor' });
    await nameShoot((await shootOf(id))!, userId, property.id);

    expect(await listUnnamedShoots(userId)).toHaveLength(0);
  });

  it('includes a visit somebody opened but never named', async () => {
    // Equally nameless and equally fixable. Making somebody visit two screens
    // for the same job would only teach them a distinction they should not
    // have to know.
    const session = await openSession({
      userId, clientRef: randomUUID(), startedAt: settled(300),
    });
    await db.query(
      `UPDATE ipy_attachment SET shoot_session_id = $2 WHERE id = $1`,
      [await photo(userId, settled(299)), session.id],
    );

    const shoots = await listUnnamedShoots(userId);
    expect(shoots).toHaveLength(1);
    expect(shoots[0]!.origin).toBe('manual');
  });

  it('hides a visit with nothing behind it', async () => {
    // Opened at the gate, then the viewing fell through. Noise, not work.
    await openSession({ userId, clientRef: randomUUID(), startedAt: settled(300) });
    expect(await listUnnamedShoots(userId)).toHaveLength(0);
  });
});

describe('a real visit outranks a guessed one', () => {
  let ctx: ServiceContext;
  let userId: string;

  beforeAll(async () => {
    ctx = await adminContext();
    const admin = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
    );
    userId = admin!.id;
  });

  beforeEach(async () => {
    await resetFor(userId);
  });

  it('takes photos back off a nameless guessed group', async () => {
    // The phone uploaded over office wi-fi and the sweep grouped the photos
    // before the visit that explains them came out of the offline queue. A
    // guess about boundaries must yield to somebody's statement about where
    // they were.
    const ids = [await photo(userId, settled(300)), await photo(userId, settled(297))];
    await groupUnfiledPhotos();
    const guessed = (await shootOf(ids[0]!))!;

    const property = await recordService.createRecord(ctx, 'properties', { name: 'Late Sync Floor' });
    const real = await openSession({
      userId, clientRef: randomUUID(), recordId: property.id, startedAt: settled(310),
    });
    await db.query(`UPDATE ipy_shoot_session SET ended_at = $2 WHERE id = $1`, [real.id, settled(290)]);

    expect(await matchOrphansForSession(real.id)).toBe(2);
    for (const id of ids) {
      expect(await shootOf(id)).toBe(real.id);
      expect(await recordOf(id)).toBe(property.id);
    }
    expect(guessed).not.toBe(real.id);
  });

  it('leaves a guessed group alone once it has been named', async () => {
    // Named is no longer a guess. A later visit whose window happens to overlap
    // must not quietly move photos out of a decision somebody made.
    const id = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    const guessed = (await shootOf(id))!;

    const chosen = await recordService.createRecord(ctx, 'properties', { name: 'Confirmed Floor' });
    await nameShoot(guessed, userId, chosen.id);

    const other = await recordService.createRecord(ctx, 'properties', { name: 'Overlapping Visit' });
    const real = await openSession({
      userId, clientRef: randomUUID(), recordId: other.id, startedAt: settled(310),
    });
    await db.query(`UPDATE ipy_shoot_session SET ended_at = $2 WHERE id = $1`, [real.id, settled(290)]);

    expect(await matchOrphansForSession(real.id)).toBe(0);
    expect(await shootOf(id)).toBe(guessed);
    expect(await recordOf(id)).toBe(chosen.id);
  });

  it('clears away a group its photos were taken from', async () => {
    // Left standing, an emptied group is a shoot with nothing in it sitting on
    // the review screen for somebody to puzzle over.
    const id = await photo(userId, settled(300));
    await groupUnfiledPhotos();
    const guessed = (await shootOf(id))!;

    const property = await recordService.createRecord(ctx, 'properties', { name: 'Emptying Floor' });
    const real = await openSession({
      userId, clientRef: randomUUID(), recordId: property.id, startedAt: settled(310),
    });
    await db.query(`UPDATE ipy_shoot_session SET ended_at = $2 WHERE id = $1`, [real.id, settled(290)]);
    await matchOrphansForSession(real.id);

    await groupUnfiledPhotos();

    const gone = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_shoot_session WHERE id = $1`, [guessed],
    );
    expect(gone).toBeNull();
  });
});
