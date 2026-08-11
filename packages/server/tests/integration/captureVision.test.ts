/**
 * Describing a shoot's photos, and — mostly — behaving correctly when nothing
 * is configured to describe them with.
 *
 * That second half is the substance of these tests, because it is the state
 * this install is actually in and the one with a trap in it. A worker that
 * spends an attempt each time it finds no provider burns its three tries in
 * three minutes, marks every shoot `failed`, and then a key added a month later
 * describes nothing — with no error anywhere to explain why.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { getDriver } from '../../src/core/storage/index.js';
import { groupUnfiledPhotos, listUnnamedShoots, nameShoot } from '../../src/core/capture/grouping.js';
import { describeShoot, processPendingShootVisions } from '../../src/core/capture/vision.js';
import { isAiAvailable } from '../../src/ai/client.js';
import { adminContext } from './fixtures.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';

const minutes = (n: number): number => n * 60_000;
const settled = (minutesAgo: number): Date => new Date(Date.now() - minutes(60 + minutesAgo));

/** A real JPEG in real storage, so the sampler's decode path runs for real. */
async function photo(userId: string, capturedAt: Date, shade = 128): Promise<string> {
  const key = `itest/vision/${randomUUID()}.jpg`;
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: shade, g: shade, b: shade } },
  }).jpeg().toBuffer();
  await (await getDriver()).save(key, bytes, 'image/jpeg');

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment (file_name, mime_type, size, storage_key, uploaded_by, captured_at)
     VALUES ('IMG.jpg','image/jpeg',$1,$2,$3,$4) RETURNING id`,
    [bytes.length, key, userId, capturedAt],
  );
  return row!.id;
}

async function resetFor(userId: string): Promise<void> {
  await db.query(`DELETE FROM ipy_attachment WHERE uploaded_by = $1`, [userId]);
  await db.query(`DELETE FROM ipy_shoot_session WHERE user_id = $1`, [userId]);
}

async function visionStateOf(sessionId: string): Promise<{
  vision_status: string; vision_attempts: number; vision_error: string | null;
  vision: Record<string, unknown>;
}> {
  return (await db.queryOne(
    `SELECT vision_status, vision_attempts, vision_error, vision
       FROM ipy_shoot_session WHERE id = $1`,
    [sessionId],
  ))!;
}

describe('describing shoots', () => {
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

  /** A grouped, nameless shoot of `count` photos. */
  async function shootOf(count: number): Promise<string> {
    for (let i = 0; i < count; i += 1) await photo(userId, settled(120 - i * 2), 60 + i * 10);
    await groupUnfiledPhotos();
    const row = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_shoot_session WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`, [userId],
    );
    return row!.id;
  }

  describe('with nothing configured — which is this install today', () => {
    it('spends no attempt and marks nothing failed', async () => {
      // The trap. Three ticks with no provider must not exhaust the retries and
      // leave every shoot permanently `failed` with no error to explain it.
      const shoot = await shootOf(3);

      for (let tick = 0; tick < 4; tick += 1) {
        expect(await processPendingShootVisions()).toEqual({ done: 0, failed: 0 });
      }

      const state = await visionStateOf(shoot);
      expect(state.vision_attempts).toBe(0);
      expect(state.vision_status).toBe('none');
      expect(state.vision_error).toBeNull();
    });

    it('leaves the shoot describable the moment a key is added', async () => {
      const shoot = await shootOf(3);
      await processPendingShootVisions();

      // Still in the worker's queue, not written off.
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM ipy_shoot_session
          WHERE vision_status IN ('none','pending') AND record_id IS NULL AND id = $1`,
        [shoot],
      );
      expect(rows).toHaveLength(1);
    });

    it('returns nothing from describeShoot rather than throwing', async () => {
      // Rule 7 in CLAUDE.md: an AI feature with no key degrades, it does not
      // throw. A throw here would fail the whole housekeeping tick.
      expect(isAiAvailable()).toBe(false);
      expect(await describeShoot(await shootOf(2))).toBeNull();
    });

    it('leaves the screen working without a description', async () => {
      // The card is designed to read fine with no summary — this is the normal
      // state of the product, not a fallback.
      await shootOf(4);
      const shoots = await listUnnamedShoots(userId);
      expect(shoots).toHaveLength(1);
      expect(shoots[0]!.summary).toBeNull();
      expect(shoots[0]!.features).toEqual([]);
      expect(shoots[0]!.mediaCount).toBe(4);
      expect(shoots[0]!.previewIds).toHaveLength(4);
    });
  });

  describe('what the worker will and will not pick up', () => {
    it('ignores a shoot that has been named', async () => {
      // The description exists to help somebody name the thing. Once they have,
      // spending a request on it would be paying to be told what we know.
      const shoot = await shootOf(3);
      const property = await recordService.createRecord(ctx, 'properties', { name: 'Described Floor' });
      await nameShoot(shoot, userId, property.id);

      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM ipy_shoot_session
          WHERE vision_status IN ('none','pending') AND record_id IS NULL AND id = $1`,
        [shoot],
      );
      expect(rows).toHaveLength(0);
    });

    it('ignores a shoot with no images in it', async () => {
      // A voice note on its own is not something to look at.
      const row = await db.queryOne<{ id: string }>(
        `INSERT INTO ipy_shoot_session (user_id, started_at, origin, status, client_ref)
         VALUES ($1, now() - interval '2 hours', 'auto', 'ready', $2) RETURNING id`,
        [userId, `itest:${randomUUID()}`],
      );
      await db.query(
        `INSERT INTO ipy_attachment (file_name, mime_type, size, storage_key, uploaded_by, shoot_session_id)
         VALUES ('note.m4a','audio/mp4',100,$1,$2,$3)`,
        [`itest/${randomUUID()}.m4a`, userId, row!.id],
      );

      const { rows } = await db.query<{ id: string }>(
        `SELECT s.id FROM ipy_shoot_session s
          WHERE s.id = $1
            AND EXISTS (SELECT 1 FROM ipy_attachment a
                         WHERE a.shoot_session_id = s.id AND a.mime_type LIKE 'image/%')`,
        [row!.id],
      );
      expect(rows).toHaveLength(0);
    });

    it('stops retrying a shoot that has failed three times', async () => {
      const shoot = await shootOf(2);
      await db.query(
        `UPDATE ipy_shoot_session
            SET vision_attempts = 3, vision_status = 'failed', vision_error = 'no vision support'
          WHERE id = $1`,
        [shoot],
      );

      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM ipy_shoot_session
          WHERE vision_status IN ('none','pending') AND vision_attempts < 3 AND id = $1`,
        [shoot],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('showing a description that exists', () => {
    it('puts the summary and features on the card', async () => {
      // Written directly rather than generated: there is no provider here, and
      // what is being tested is the read path the screen depends on.
      const shoot = await shootOf(5);
      await db.query(
        `UPDATE ipy_shoot_session SET vision = $2::jsonb, vision_status = 'done' WHERE id = $1`,
        [shoot, JSON.stringify({
          summary: '3 BHK builder floor — marble flooring, modular kitchen',
          rooms: ['living room', 'kitchen'],
          features: ['modular kitchen', 'marble flooring', 'covered parking'],
          coverAttachmentId: null,
          describedAt: new Date().toISOString(),
          sampled: 5,
        })],
      );

      const [card] = await listUnnamedShoots(userId);
      expect(card!.summary).toBe('3 BHK builder floor — marble flooring, modular kitchen');
      expect(card!.features).toEqual(['modular kitchen', 'marble flooring', 'covered parking']);
    });

    it('leads with the cover the model chose', async () => {
      // Otherwise the first thumbnail is whichever shot was taken earliest,
      // which on a real walkthrough is usually a doorway.
      const shoot = await shootOf(5);
      const ids = await db.query<{ id: string }>(
        `SELECT id FROM ipy_attachment WHERE shoot_session_id = $1 ORDER BY captured_at`, [shoot],
      );
      const cover = ids.rows[3]!.id; // deliberately not the first by time

      await db.query(
        `UPDATE ipy_shoot_session SET vision = $2::jsonb, vision_status = 'done' WHERE id = $1`,
        [shoot, JSON.stringify({ summary: 'A floor', coverAttachmentId: cover })],
      );

      const [card] = await listUnnamedShoots(userId);
      expect(card!.previewIds[0]).toBe(cover);
    });

    it('survives a vision blob with junk in it', async () => {
      // The values come from a model. A summary that arrived as a number, or
      // features as a string, must not break the evening screen.
      const shoot = await shootOf(2);
      await db.query(
        `UPDATE ipy_shoot_session SET vision = $2::jsonb WHERE id = $1`,
        [shoot, JSON.stringify({ summary: 42, features: 'modular kitchen', coverAttachmentId: 'not-a-uuid' })],
      );

      const [card] = await listUnnamedShoots(userId);
      expect(card!.summary).toBeNull();
      expect(card!.features).toEqual([]);
      expect(card!.previewIds).toHaveLength(2);
    });
  });
});
