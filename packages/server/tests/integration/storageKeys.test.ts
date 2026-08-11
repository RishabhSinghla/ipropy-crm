/**
 * Storage keys are derived from the record, not from a bare UUID.
 *
 * The point is that a bucket mirrored to a laptop with rclone is browsable —
 * so these assert on the shape of the path a human would see, and on the two
 * properties that must hold whatever the name contains: it is unique, and it
 * cannot climb out of the storage root.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { registry } from '../../src/core/metadata/registry.js';
import { buildStorageKey, slug } from '../../src/core/storage/keys.js';
import { localPath } from '../../src/core/storage/index.js';
import { config } from '../../src/config.js';
import { adminContext } from './fixtures.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';

describe('storage keys', () => {
  let ctx: ServiceContext;

  beforeAll(async () => {
    ctx = await adminContext();
    await registry.requireModule('properties');
  });

  it('names the folder after the record, not a UUID', async () => {
    const created = await recordService.createRecord(ctx, 'properties', { name: 'Verdant Greens — Tower D, Unit 702' });
    const key = await buildStorageKey({ recordId: created.id, originalName: 'IMG_9001.HEIC', ext: '.heic' });

    expect(key).toMatch(/^properties\//);
    expect(key).toContain('verdant-greens-tower-d-unit-702');
    // Still obviously the photo it came from, with a tail for uniqueness.
    expect(key).toMatch(/\/img-9001-[0-9a-f]{8}\.heic$/);
  });

  it('leads the folder with the record number, since that is what people quote', async () => {
    const created = await recordService.createRecord(ctx, 'properties', { name: 'Numbered Unit' });
    const row = await db.queryOne<{ record_number: string | null }>(
      `SELECT record_number FROM ipy_record WHERE id = $1`, [created.id],
    );
    const key = await buildStorageKey({ recordId: created.id, originalName: 'a.jpg', ext: '.jpg' });

    if (row?.record_number) {
      expect(key.split('/')[1].startsWith(slug(row.record_number))).toBe(true);
    }
    expect(key.split('/')[1]).toContain('numbered-unit');
  });

  it('never collides when the same phone filename is uploaded twice', async () => {
    // Two photos off one phone are honestly both IMG_9001.jpg. Without the
    // unique tail the second save() would overwrite the first.
    const created = await recordService.createRecord(ctx, 'properties', { name: 'Same Names' });
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => buildStorageKey({ recordId: created.id, originalName: 'IMG_9001.jpg', ext: '.jpg' })),
    );
    expect(new Set(keys).size).toBe(8);
  });

  it('falls back to the record id when the name has no ASCII form', async () => {
    const created = await recordService.createRecord(ctx, 'properties', { name: 'ग्रीनफील्ड' });
    const key = await buildStorageKey({ recordId: created.id, originalName: 'फोटो.jpg', ext: '.jpg' });

    const [module, folder, file] = key.split('/');
    expect(module).toBe('properties');
    expect(folder).not.toBe('');
    expect(file).toMatch(/^[a-z0-9-]+\.jpg$/);
    // Whatever it fell back to, it is still ASCII and still a usable path.
    expect(key).toMatch(/^[a-z0-9/_.-]+$/);
  });

  it('files an unattached upload under unfiled/, still by month', async () => {
    const key = await buildStorageKey({ recordId: null, originalName: 'brochure.pdf', ext: '.pdf' });
    expect(key).toMatch(/^unfiled\/\d{4}-\d{2}\/brochure-[0-9a-f]{8}\.pdf$/);
  });

  it('survives a record that has been deleted between upload and key build', async () => {
    const key = await buildStorageKey({
      recordId: '00000000-0000-0000-0000-000000000000', originalName: 'x.jpg', ext: '.jpg',
    });
    expect(key).toMatch(/^unfiled\//);
  });

  it('cannot escape the storage root, whatever the record is called', async () => {
    const root = resolve(config.storage.localPath);
    for (const name of ['../../etc/passwd', '..\\..\\windows', '../../../root']) {
      const created = await recordService.createRecord(ctx, 'properties', { name });
      const key = await buildStorageKey({ recordId: created.id, originalName: '../../evil.jpg', ext: '.jpg' });
      expect(key).not.toContain('..');
      // localPath is the last line of defence; prove the two agree.
      expect(resolve(localPath(key)).startsWith(root)).toBe(true);
    }
  });

  it('keeps derivative keys next to the original', async () => {
    // images.ts/video.ts build their keys by stripping the extension and
    // appending — so the layout only works if the base is a real path.
    const created = await recordService.createRecord(ctx, 'properties', { name: 'Derivative Home' });
    const key = await buildStorageKey({ recordId: created.id, originalName: 'IMG_1.jpg', ext: '.jpg' });
    const base = key.slice(0, key.lastIndexOf('.'));
    expect(`${base}-large.webp`.split('/').slice(0, -1).join('/')).toBe(key.split('/').slice(0, -1).join('/'));
  });

  describe('slug', () => {
    it('folds accents and drops everything a path should not carry', () => {
      expect(slug('Café Royale')).toBe('cafe-royale');
      expect(slug('B-110, Greenfield')).toBe('b-110-greenfield');
      expect(slug('  spaced  out  ')).toBe('spaced-out');
      expect(slug('!!!')).toBe('');
    });

    it('caps length without leaving a trailing hyphen', () => {
      const long = slug('a'.repeat(20) + ' ' + 'b'.repeat(60), 24);
      expect(long.length).toBeLessThanOrEqual(24);
      expect(long.endsWith('-')).toBe(false);
    });
  });
});
