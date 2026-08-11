/**
 * Filing photos against the visit they were shot on.
 *
 * The last link in the chain, and the one with the most ways to be quietly
 * wrong: a photo attached to the property next door looks exactly like a photo
 * attached correctly until somebody sends it to a client.
 *
 * These build real JPEGs with real EXIF and read them back, rather than
 * stubbing the reader — the timezone arithmetic and the tag parsing are the
 * whole feature, and a test that mocks them tests nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { captureTimeFromImage } from '../../src/core/capture/captureTime.js';
import { matchAttachment, matchOrphansForSession } from '../../src/core/capture/matching.js';
import { openSession } from '../../src/core/capture/sessions.js';
import { adminContext, authUser, SEEDED } from './fixtures.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';

const minutes = (n: number): number => n * 60_000;

/** A real JPEG carrying a real DateTimeOriginal. */
function photoTakenAt(wallClock: string, offset?: string): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
    // IFD2 is sharp's key for the Exif sub-IFD — `ExifIFD` and `Exif` are
    // accepted without complaint and silently written nowhere, which is worth
    // knowing before spending an afternoon on it.
    .withExif({
      IFD0: { Make: 'Apple', Model: 'iPhone' },
      IFD2: {
        DateTimeOriginal: wallClock,
        ...(offset ? { OffsetTimeOriginal: offset } : {}),
      },
    })
    .jpeg()
    .toBuffer();
}

/**
 * Clear this user's visits and unfiled attachments.
 *
 * The suites above deliberately leave attachments unmatched, and a visit with
 * an open-ended window would legitimately claim them — so the late-sync tests
 * have to start from nothing to be measuring what they think they are.
 */
async function resetFor(userId: string): Promise<void> {
  await db.query(`DELETE FROM ipy_shoot_session WHERE user_id = $1`, [userId]);
  await db.query(`DELETE FROM ipy_attachment WHERE uploaded_by = $1 AND shoot_session_id IS NULL`, [userId]);
}

async function attachment(userId: string, recordId: string | null): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, uploaded_by)
     VALUES ($1,'IMG.jpg','image/jpeg',10,$2,$3) RETURNING id`,
    [recordId, `itest/${randomUUID()}.jpg`, userId],
  );
  return row!.id;
}

describe('reading capture time from a real photo', () => {
  it('reads the tag and applies the offset the camera recorded', async () => {
    // 09:03 in Greenfield is 03:33 UTC. Getting this wrong is the entire bug
    // this feature has to avoid.
    const buf = await photoTakenAt('2026:08:11 09:03:00', '+05:30');
    const at = await captureTimeFromImage(buf);
    expect(at?.toISOString()).toBe('2026-08-11T03:33:00.000Z');
  });

  it('falls back to the organisation timezone when the camera recorded none', async () => {
    // Older phones and most DSLRs write no OffsetTimeOriginal at all.
    const buf = await photoTakenAt('2026:08:11 09:03:00');
    const at = await captureTimeFromImage(buf);
    expect(at?.toISOString()).toBe('2026-08-11T03:33:00.000Z');
  });

  it('honours a foreign offset over the local assumption', async () => {
    const buf = await photoTakenAt('2026:08:11 09:03:00', '-04:00');
    const at = await captureTimeFromImage(buf);
    expect(at?.toISOString()).toBe('2026-08-11T13:03:00.000Z');
  });

  it('returns nothing for an image with no EXIF at all', async () => {
    // A screenshot, a WhatsApp forward, a pasted image. Unknown must stay
    // unknown — inventing a time would file it confidently and wrongly.
    const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#111' } })
      .jpeg().toBuffer();
    expect(await captureTimeFromImage(plain)).toBeNull();
  });

  it('does not throw on a file that is not an image', async () => {
    expect(await captureTimeFromImage(Buffer.from('this is not a jpeg'))).toBeNull();
  });
});

describe('matching a photo to a visit', () => {
  let ctx: ServiceContext;
  let userId: string;

  beforeAll(async () => {
    ctx = await adminContext();
    await registry.requireModule('properties');
    const admin = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
    );
    userId = admin!.id;
    await db.query(`DELETE FROM ipy_shoot_session WHERE user_id = $1`, [userId]);
  });

  it('files a photo against the visit that was happening when it was shot', async () => {
    const property = await recordService.createRecord(ctx, 'properties', { name: 'Matched Floor' });
    await openSession({
      userId, clientRef: randomUUID(), recordId: property.id,
      startedAt: new Date(Date.now() - minutes(30)),
    });

    const id = await attachment(userId, null);
    const result = await matchAttachment(id, new Date(Date.now() - minutes(25)));

    expect(result.sessionId).toBeTruthy();
    expect(result.attachedToRecord).toBe(true);

    const row = await db.queryOne<{ record_id: string; shoot_session_id: string; captured_at: Date }>(
      `SELECT record_id, shoot_session_id, captured_at FROM ipy_attachment WHERE id = $1`, [id],
    );
    expect(row?.record_id).toBe(property.id);
    expect(row?.captured_at).toBeTruthy();
  });

  it('never overrides a property somebody chose explicitly', async () => {
    // A file uploaded from a property's own Files tab already knows where it
    // belongs; inference must not second-guess that.
    const chosen = await recordService.createRecord(ctx, 'properties', { name: 'Chosen Floor' });
    const visited = await recordService.createRecord(ctx, 'properties', { name: 'Visited Floor' });
    await openSession({
      userId, clientRef: randomUUID(), recordId: visited.id,
      startedAt: new Date(Date.now() - minutes(20)),
    });

    const id = await attachment(userId, chosen.id);
    const result = await matchAttachment(id, new Date(Date.now() - minutes(15)));

    // Still filed against the visit — useful — but the property is untouched.
    expect(result.sessionId).toBeTruthy();
    expect(result.attachedToRecord).toBe(false);
    const row = await db.queryOne<{ record_id: string }>(
      `SELECT record_id FROM ipy_attachment WHERE id = $1`, [id],
    );
    expect(row?.record_id).toBe(chosen.id);
  });

  it('stores the capture time even when nothing matches', async () => {
    // Worth having on its own: it is what sorts a gallery into the order things
    // were shot rather than the order they finished uploading.
    const id = await attachment(userId, null);
    const shotLastYear = new Date('2025-03-01T04:00:00Z');
    const result = await matchAttachment(id, shotLastYear);

    expect(result.sessionId).toBeNull();
    const row = await db.queryOne<{ captured_at: Date; record_id: string | null }>(
      `SELECT captured_at, record_id FROM ipy_attachment WHERE id = $1`, [id],
    );
    expect(row?.captured_at?.toISOString()).toBe(shotLastYear.toISOString());
    expect(row?.record_id).toBeNull();
  });

  it('files nothing when the capture time is unknown', async () => {
    const property = await recordService.createRecord(ctx, 'properties', { name: 'Unknowable Floor' });
    await openSession({
      userId, clientRef: randomUUID(), recordId: property.id,
      startedAt: new Date(Date.now() - minutes(10)),
    });

    const id = await attachment(userId, null);
    const result = await matchAttachment(id, null);

    expect(result.sessionId).toBeNull();
    const row = await db.queryOne<{ record_id: string | null }>(
      `SELECT record_id FROM ipy_attachment WHERE id = $1`, [id],
    );
    expect(row?.record_id).toBeNull();
  });

  it('will not file one person\'s photo against another\'s visit', async () => {
    const property = await recordService.createRecord(ctx, 'properties', { name: 'Someone Elses Floor' });
    await openSession({
      userId, clientRef: randomUUID(), recordId: property.id,
      startedAt: new Date(Date.now() - minutes(10)),
    });

    const other = await authUser(SEEDED.executiveB);
    const id = await attachment(other.id, null);
    const result = await matchAttachment(id, new Date(Date.now() - minutes(5)));
    expect(result.sessionId).toBeNull();
  });

  it('is safe to run twice', async () => {
    // The media queue retries; a second pass must reach the same answer rather
    // than moving the photo.
    const property = await recordService.createRecord(ctx, 'properties', { name: 'Idempotent Floor' });
    await openSession({
      userId, clientRef: randomUUID(), recordId: property.id,
      startedAt: new Date(Date.now() - minutes(8)),
    });

    const id = await attachment(userId, null);
    const shotAt = new Date(Date.now() - minutes(4));
    const first = await matchAttachment(id, shotAt);
    const second = await matchAttachment(id, shotAt);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.attachedToRecord).toBe(false); // already done the first time
    const row = await db.queryOne<{ record_id: string }>(
      `SELECT record_id FROM ipy_attachment WHERE id = $1`, [id],
    );
    expect(row?.record_id).toBe(property.id);
  });
});

describe('a visit that syncs after its photos', () => {
  let ctx: ServiceContext;
  let userId: string;

  beforeAll(async () => {
    ctx = await adminContext();
    const admin = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
    );
    userId = admin!.id;
  });

  it('claims the photos it explains', async () => {
    // The offline case, and not a rare one: the phone uploads over the office
    // wi-fi while the visit is still sitting in the capture queue. Those photos
    // are processed with no session to find.
    await resetFor(userId);
    const shotAt = new Date(Date.now() - minutes(45));
    const orphan = await attachment(userId, null);
    await matchAttachment(orphan, shotAt);

    let row = await db.queryOne<{ shoot_session_id: string | null }>(
      `SELECT shoot_session_id FROM ipy_attachment WHERE id = $1`, [orphan],
    );
    expect(row?.shoot_session_id).toBeNull();

    // Now the visit arrives.
    const property = await recordService.createRecord(ctx, 'properties', { name: 'Late Sync Floor' });
    const session = await openSession({
      userId, clientRef: randomUUID(), recordId: property.id,
      startedAt: new Date(Date.now() - minutes(50)),
    });
    const claimed = await matchOrphansForSession(session.id);

    expect(claimed).toBe(1);
    row = await db.queryOne(`SELECT shoot_session_id, record_id FROM ipy_attachment WHERE id = $1`, [orphan]);
    expect(row?.shoot_session_id).toBe(session.id);
    expect((row as unknown as { record_id: string }).record_id).toBe(property.id);
  });

  it('claims only photos taken inside its own window', async () => {
    await resetFor(userId);
    const inside = await attachment(userId, null);
    const outside = await attachment(userId, null);
    await matchAttachment(inside, new Date(Date.now() - minutes(20)));
    await matchAttachment(outside, new Date(Date.now() - minutes(200)));

    const property = await recordService.createRecord(ctx, 'properties', { name: 'Windowed Floor' });
    const session = await openSession({
      userId, clientRef: randomUUID(), recordId: property.id,
      startedAt: new Date(Date.now() - minutes(30)),
    });
    await db.query(`UPDATE ipy_shoot_session SET ended_at = now() WHERE id = $1`, [session.id]);

    expect(await matchOrphansForSession(session.id)).toBe(1);
    const stillFree = await db.queryOne<{ shoot_session_id: string | null }>(
      `SELECT shoot_session_id FROM ipy_attachment WHERE id = $1`, [outside],
    );
    expect(stillFree?.shoot_session_id).toBeNull();
  });
});
