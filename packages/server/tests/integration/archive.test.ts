/**
 * The per-record download.
 *
 * The thing that matters here is not that bytes came back — it is that the zip
 * is a *real* zip that opens in Finder and Explorer, with folders a human
 * recognises and a property.json that survives the CRM. So these tests unzip
 * what the code produced with an independent reader (yauzl) and read the
 * entries back, rather than asserting on a byte count.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import { db } from '../../src/db/pool.js';
import { getDriver } from '../../src/core/storage/index.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { registry } from '../../src/core/metadata/registry.js';
import {
  contentDisposition, countRecordMedia, safeName, writeRecordArchive, type ArchiveSet,
} from '../../src/core/media/archive.js';
import { adminContext } from './fixtures.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';

/** Collect a stream into one Buffer, so the zip can be handed to a reader. */
function collector(): { stream: Writable; done: Promise<Buffer> } {
  const chunks: Buffer[] = [];
  let finish: (b: Buffer) => void;
  const done = new Promise<Buffer>((resolve) => { finish = resolve; });
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    final(cb) { finish(Buffer.concat(chunks)); cb(); },
  });
  return { stream, done };
}

/** Read every entry out of a zip buffer as path → contents. */
function unzip(buf: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) { reject(err ?? new Error('not a zip')); return; }
      const out = new Map<string, string>();
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { reject(streamErr ?? new Error('unreadable entry')); return; }
          const parts: Buffer[] = [];
          stream.on('data', (d: Buffer) => parts.push(d));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(parts).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** A property record with attachments whose bytes really exist in storage. */
async function propertyWithMedia(ctx: ServiceContext, name: string): Promise<string> {
  const created = await recordService.createRecord(ctx, 'properties', { name });
  const driver = await getDriver();

  // Two attachments deliberately sharing a file name, to prove the de-duping.
  for (const marker of ['first', 'second']) {
    const originalKey = `itest/${randomUUID()}.jpg`;
    const largeKey = `itest/${randomUUID()}-large.webp`;
    const mediumKey = `itest/${randomUUID()}-medium.webp`;
    await driver.save(originalKey, Buffer.from(`original-${marker}`), 'image/jpeg');
    await driver.save(largeKey, Buffer.from(`large-${marker}`), 'image/webp');
    await driver.save(mediumKey, Buffer.from(`medium-${marker}`), 'image/webp');

    await db.query(
      `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, variants)
       VALUES ($1,'IMG_9001.jpg','image/jpeg',10,$2,$3::jsonb)`,
      [created.id, originalKey, JSON.stringify({ large: largeKey, medium: mediumKey, thumb: 'itest/nope-thumb.webp' })],
    );
  }
  return created.id;
}

async function archiveOf(recordId: string, folder: string, set: ArchiveSet): Promise<Map<string, string>> {
  const { stream, done } = collector();
  await writeRecordArchive(recordId, 'properties', folder, set, { name: folder }, stream);
  return unzip(await done);
}

describe('per-record media archive', () => {
  let ctx: ServiceContext;
  let recordId: string;

  beforeAll(async () => {
    ctx = await adminContext();
    await registry.requireModule('properties');
    recordId = await propertyWithMedia(ctx, 'B110 Greenfield');
  });

  it('produces a zip a normal tool can open', async () => {
    const entries = await archiveOf(recordId, 'B110 Greenfield', 'all');
    expect(entries.size).toBeGreaterThan(0);
  });

  it('lays the files out in folders a human recognises', async () => {
    const entries = await archiveOf(recordId, 'B110 Greenfield', 'all');
    const paths = [...entries.keys()].sort();

    expect(paths).toContain('B110 Greenfield/originals/IMG_9001.jpg');
    expect(paths).toContain('B110 Greenfield/branded/IMG_9001.webp');
    expect(paths).toContain('B110 Greenfield/web/IMG_9001.webp');
    expect(paths).toContain('B110 Greenfield/property.json');
  });

  it('keeps both photos when two share a file name', async () => {
    const entries = await archiveOf(recordId, 'B110 Greenfield', 'originals');
    expect(entries.get('B110 Greenfield/originals/IMG_9001.jpg')).toBe('original-first');
    expect(entries.get('B110 Greenfield/originals/IMG_9001 (2).jpg')).toBe('original-second');
  });

  it('never exports thumbnails', async () => {
    const entries = await archiveOf(recordId, 'B110 Greenfield', 'all');
    expect([...entries.keys()].some((p) => p.includes('thumb'))).toBe(false);
  });

  it('serves the watermarked derivative in branded, not the original', async () => {
    const entries = await archiveOf(recordId, 'B110 Greenfield', 'branded');
    expect(entries.get('B110 Greenfield/branded/IMG_9001.webp')).toBe('large-first');
    // `branded` must not drag several GB of originals along with it.
    expect([...entries.keys()].some((p) => p.includes('/originals/'))).toBe(false);
  });

  it('writes a property.json that stands on its own', async () => {
    const entries = await archiveOf(recordId, 'B110 Greenfield', 'branded');
    const manifest = JSON.parse(entries.get('B110 Greenfield/property.json')!);
    expect(manifest.name).toBe('B110 Greenfield');
    expect(manifest.media.files).toBe(2);
    expect(manifest.media.set).toBe('branded');
    expect(manifest.media.missing).toEqual([]);
  });

  it('reports a storage key that has gone missing instead of failing the download', async () => {
    const orphan = await recordService.createRecord(ctx, 'properties', { name: 'Orphan Floor' });
    await db.query(
      `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key)
       VALUES ($1,'gone.jpg','image/jpeg',10,'itest/definitely-not-there.jpg')`,
      [orphan.id],
    );

    const entries = await archiveOf(orphan.id, 'Orphan Floor', 'originals');
    const manifest = JSON.parse(entries.get('Orphan Floor/property.json')!);
    expect(manifest.media.files).toBe(0);
    expect(manifest.media.missing).toEqual(['itest/definitely-not-there.jpg']);
  });

  it('counts media so the route can refuse before it starts streaming', async () => {
    const empty = await recordService.createRecord(ctx, 'properties', { name: 'No Media Yet' });
    expect(await countRecordMedia(empty.id)).toBe(0);
    expect(await countRecordMedia(recordId)).toBe(2);
  });

  describe('safeName', () => {
    it('strips what Windows refuses, without destroying the name', () => {
      expect(safeName('B-110/Greenfield: "corner"')).toBe('B-110 Greenfield corner');
      expect(safeName('A<b>c|d?e*f"g:h')).toBe('A b c d e f g h');
      // Windows drops a trailing dot, which would desync the folder from the
      // name property.json reports.
      expect(safeName('Plot 12.')).toBe('Plot 12');
      expect(safeName('')).toBe('untitled');
      expect(safeName('   ', 'Property')).toBe('Property');
    });

    it('keeps hyphens, because that is how property codes are written', () => {
      // The regression this replaced turned "B-110" into "B 110" — a different,
      // wrong-looking code on every folder and every manifest.
      expect(safeName('B-110')).toBe('B-110');
      expect(safeName('B-110 Greenfield')).toBe('B-110 Greenfield');
    });

    it('cannot produce a path that escapes the archive root', () => {
      expect(safeName('../../etc/passwd')).not.toContain('/');
      expect(safeName('..\\..\\windows')).not.toContain('\\');
    });
  });

  describe('contentDisposition', () => {
    /**
     * Found in the browser, not here: the seeded property "Verdant Greens —
     * Tower D, Unit 702" made the whole download 500, because Node refuses a
     * non-Latin-1 header value. Every test above had used ASCII names.
     */
    it('survives the characters these names actually contain', () => {
      const header = contentDisposition('Verdant Greens — Tower D, Unit 702.zip');
      expect(() => Buffer.from(header, 'latin1').toString('latin1')).not.toThrow();
      // eslint-disable-next-line no-control-regex
      expect(header).toMatch(/^[\x20-\x7e]*$/);
      expect(header).toContain("filename*=UTF-8''");
      // The real name is still recoverable by any client that understands RFC 6266.
      const star = header.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(star)).toBe('Verdant Greens — Tower D, Unit 702.zip');
    });

    it('handles rupee symbols and Devanagari', () => {
      for (const name of ['₹2.25 Cr — B110.zip', 'ग्रीनफील्ड B-110.zip', 'Curly “quoted” name.zip']) {
        const header = contentDisposition(name);
        // eslint-disable-next-line no-control-regex
        expect(header, name).toMatch(/^[\x20-\x7e]*$/);
        expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe(name);
      }
    });

    it('cannot break out of the quoted ASCII fallback', () => {
      const header = contentDisposition('evil"; drop=1; x=".zip');
      const fallback = header.slice(header.indexOf('"') + 1, header.indexOf('";'));
      expect(fallback).not.toContain('"');
      expect(fallback).not.toContain('\\');
    });
  });
});
