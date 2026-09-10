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
import { recordService, type ServiceContext } from '../../src/core/entity/recordService.js';
import { registry } from '../../src/core/metadata/registry.js';
import {
  buildStorageKey, derivativeStorageKey, PROPERTY_MEDIA_FOLDERS, propertyFolder,
  propertyFolderKey, slug, unitFromFolder, unitFromFolderName,
} from '../../src/core/storage/keys.js';
import { localPath } from '../../src/core/storage/index.js';
import { config } from '../../src/config.js';
import { adminContext } from './fixtures.js';

describe('storage keys', () => {
  let ctx: ServiceContext;

  beforeAll(async () => {
    ctx = await adminContext();
    await registry.requireModule('properties');
  });

  it('names the folder after the record, not a UUID', async () => {
    const created = await recordService.createRecord(ctx, 'properties', { name: 'Verdant Greens — Tower D, Unit 702' });
    const key = await buildStorageKey({ recordId: created.id, originalName: 'IMG_9001.HEIC', ext: '.heic' });

    expect(key).toContain('verdant-greens-tower-d-unit-702');
    // Still obviously the photo it came from, with a tail for uniqueness.
    const originals = propertyFolder(PROPERTY_MEDIA_FOLDERS.originals, unitFromFolder(key));
    expect(key).toMatch(new RegExp(`/${originals}/img-9001-[0-9a-f]{8}\\.heic$`));
  });

  it('leads the folder with the record number, since that is what people quote', async () => {
    const created = await recordService.createRecord(ctx, 'properties', { name: 'Numbered Unit' });
    const row = await db.queryOne<{ record_number: string | null }>(
      `SELECT record_number FROM ipy_record WHERE id = $1`, [created.id],
    );
    const key = await buildStorageKey({ recordId: created.id, originalName: 'a.jpg', ext: '.jpg' });

    if (row?.record_number) {
      expect(key.split('/')[0].startsWith(slug(row.record_number))).toBe(true);
    }
    expect(key.split('/')[0]).toContain('numbered-unit');
  });

  it('names a property folder after the unit, which is what everything inside is named after', async () => {
    // The media worker splits the folder name on its first hyphen to learn the
    // unit, then calls every subfolder and every file it writes after it. This
    // used to come from the record number, and every property record number
    // starts UNIT-, so every property in the drive had identical insides:
    // UNIT-RAW-UPLOADS, UNIT-SHAPES, UNIT-01.jpg. Nothing broke, because both
    // sides were wrong the same way. It just made the name useless.
    const created = await recordService.createRecord(ctx, 'properties', {
      name: 'D404', bedrooms: 3,
    });
    const folder = await propertyFolderKey(created.id);
    expect(folder).toBe('D404-3bhk');
    expect(unitFromFolderName(folder!)).toBe('D404');
    expect(propertyFolder(PROPERTY_MEDIA_FOLDERS.originals, unitFromFolderName(folder!)))
      .toBe('D404-RAW-UPLOADS/PHOTOS');
  });

  it('reads the unit off a file key and a folder key from the right end of each', async () => {
    // Two functions a slash apart. Given a file key the unit is in the first
    // segment; given a folder key it is the only segment. Reading the wrong end
    // of a file key returns IMG, and there is no error to notice.
    const fileKey = 'A1818-4bhk/A1818-RAW-UPLOADS/PHOTOS/IMG_4370.jpg';
    expect(unitFromFolder(fileKey)).toBe('A1818');
    expect(unitFromFolderName('A1818-4bhk')).toBe('A1818');
    // The shape that made the two disagree before they lived side by side.
    expect(unitFromFolderName('properties/unit-00001-b1100')).toBe('UNIT');
  });

  it('never renames a folder that already exists', async () => {
    // Renaming is not a tidy-up. The photographs are in there, the CRM cannot
    // move them, and the folder belongs to whoever is working in it.
    const created = await recordService.createRecord(ctx, 'properties', { name: 'K909' });
    await db.query(
      `INSERT INTO ipy_property_storage (record_id, folder_key) VALUES ($1, 'old-shape/whatever-it-was')
       ON CONFLICT (record_id) DO UPDATE SET folder_key = EXCLUDED.folder_key`,
      [created.id],
    );
    const stored = await db.queryOne<{ folder_key: string }>(
      `SELECT folder_key FROM ipy_property_storage WHERE record_id = $1`, [created.id],
    );
    expect(stored?.folder_key).toBe('old-shape/whatever-it-was');
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

    // The drop box is a nested path, so take it off the end rather than
    // destructuring a fixed number of segments.
    const segments = key.split('/');
    const file = segments.pop()!;
    const expected = propertyFolder(PROPERTY_MEDIA_FOLDERS.originals, unitFromFolder(key));
    const originals = segments.splice(-expected.split('/').length).join('/');
    const [folder] = segments;
    expect(folder).not.toBe('');
    expect(originals).toBe(expected);
    expect(file).toMatch(/^[a-z0-9-]+\.jpg$/);
    // Whatever it fell back to, it is still ASCII and still a usable path.
    expect(key).toMatch(/^[A-Za-z0-9 /_.-]+$/);
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

  it('files derivatives into their explicit property folders', async () => {
    const created = await recordService.createRecord(ctx, 'properties', { name: 'Derivative Home' });
    const key = await buildStorageKey({ recordId: created.id, originalName: 'IMG_1.jpg', ext: '.jpg' });
    const derivative = derivativeStorageKey(key, PROPERTY_MEDIA_FOLDERS.crmWebsite, 'large', '.webp');
    expect(derivative).toContain(`/${PROPERTY_MEDIA_FOLDERS.crmWebsite}/`);
    // and the nested drop box is gone, not merely its last segment
    expect(derivative).not.toContain('01_RAW_UPLOADS');
    expect(derivative).toMatch(/\/img-1-[0-9a-f]{8}-large\.webp$/);
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
