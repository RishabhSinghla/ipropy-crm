/**
 * "Download everything for this property" as a single zip.
 *
 * The CRM is a catalogue, not a vault: the files behind a record are ordinary
 * objects in storage and this is the door out of them. What comes back is a
 * plain folder tree plus a property.json describing the record, which is
 * readable by anything — Finder, Explorer, another CRM, a future version of
 * this one — with no dependency on iPropy still existing.
 *
 *   B110 Greenfield/
 *     originals/      exactly what came off the phone, untouched
 *     branded/        the watermarked derivatives (and the titled video)
 *     web/            the smaller website/WhatsApp sizes
 *     property.json
 *
 * Two decisions worth knowing:
 *
 * STORED, not deflated. Every payload here is already-compressed media — JPEG,
 * HEIC, WebP, MP4. Deflating them buys a percent or two and costs a great deal
 * of CPU, which matters when this runs on a free instance or the laptop in
 * somebody's office. Storing makes the zip close to a concatenation: fast,
 * and it streams at disk speed.
 *
 * Never fully buffered. A property's raw set can be several GB of 4K video, so
 * entries are appended as file streams and the response is written as it is
 * produced (see the route in api/routes/misc.ts). `readToTempFile` is the same
 * mechanism the ffmpeg pipeline uses: a no-op path for the local driver, a
 * temporary download for S3, cleaned up either way.
 */
// archiver 8 is ESM-only and no longer exports a callable default — the format
// classes are the entry point now (`archiver('zip', …)` was the 7.x API).
import { ZipArchive, type ArchiverError } from 'archiver';
import type { Writable } from 'node:stream';
import { extname } from 'node:path';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { getDriver } from '../storage/index.js';
import { photoOrderBy } from './ordering.js';

/** Which folders the caller wants. `branded` is the useful default for sharing. */
export type ArchiveSet = 'all' | 'originals' | 'branded' | 'web';

export const ARCHIVE_SETS: ArchiveSet[] = ['all', 'originals', 'branded', 'web'];

interface AttachmentRow {
  id: string;
  file_name: string;
  mime_type: string;
  storage_key: string;
  variants: Record<string, string> | null;
  created_at: Date;
}

/**
 * Filesystem-safe, and still recognisable to a human.
 *
 * Windows is the strict one — it rejects <>:"/\|?*, control characters, and
 * trailing dots or spaces — and this zip is expected to be opened there.
 *
 * Only genuinely illegal characters go. Hyphens and spaces stay: property codes
 * are written "B-110", and dropping the hyphen turns that into a different,
 * wrong-looking code. Illegal characters become a space rather than vanishing,
 * so "B-110/Greenfield" reads as "B-110 Greenfield" and not "B-110Greenfield".
 *
 * Stripping the separators is also what makes this traversal-proof: with no
 * slash or backslash left, a name like "../../etc" cannot climb out of the
 * archive root whatever it started as.
 */
const ILLEGAL_IN_FILENAME = /[<>:"|?*\\/\u0000-\u001F]/g;

export function safeName(input: string, fallback = 'untitled'): string {
  const cleaned = input
    .replace(ILLEGAL_IN_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    // Windows silently drops a trailing dot or space, so "Plot 12." would
    // arrive as "Plot 12" and stop matching what property.json calls it.
    // After the slice, since truncation can expose one.
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || fallback;
}

/**
 * `IMG_9001.heic` + `.webp` → `IMG_9001.webp`.
 *
 * Derivatives are stored under generated keys (`<uuid>-large.webp`), which say
 * nothing to whoever opens the folder. Naming them after the original is what
 * makes `originals/IMG_9001.heic` and `branded/IMG_9001.webp` line up as
 * obviously the same photo.
 */
function derivativeName(originalFileName: string, variantKey: string): string {
  const ext = extname(variantKey) || extname(originalFileName);
  const base = originalFileName.slice(0, originalFileName.length - extname(originalFileName).length);
  return `${safeName(base, 'file')}${ext}`;
}

/**
 * Two photos can genuinely be called IMG_9001.heic — different shoots, same
 * counter. A zip with duplicate paths extracts to whichever entry wins, so
 * later ones get " (2)" rather than silently disappearing.
 */
function uniquePath(taken: Set<string>, path: string): string {
  if (!taken.has(path)) { taken.add(path); return path; }
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  for (let i = 2; ; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}

/** Which storage key belongs in which folder, for one attachment. */
function entriesFor(row: AttachmentRow, set: ArchiveSet): { folder: string; key: string; name: string }[] {
  const out: { folder: string; key: string; name: string }[] = [];
  const wants = (folder: string): boolean => set === 'all' || set === folder;
  const variants = row.variants ?? {};

  if (wants('originals')) {
    out.push({ folder: 'originals', key: row.storage_key, name: safeName(row.file_name, 'file') });
  }
  // Images watermark at `large`; video's single `web` derivative is the one
  // carrying the title card, so it is the branded artefact for a clip.
  const branded = variants.watermarked ?? variants.large ?? variants.web;
  if (wants('branded') && branded) {
    out.push({ folder: 'branded', key: branded, name: derivativeName(row.file_name, branded) });
  }
  // `medium` is the website/WhatsApp size. Video has no second size, so its web
  // folder entry is the same mp4 — included so `?set=web` is never empty for a
  // property whose media is all video.
  const web = variants.medium ?? variants.web;
  if (wants('web') && web) {
    out.push({ folder: 'web', key: web, name: derivativeName(row.file_name, web) });
  }
  // `thumb` is deliberately never exported: a 480px thumbnail is an internal
  // rendering detail, and it only clutters the folder somebody opens.
  return out;
}

/**
 * A `Content-Disposition` value that survives a non-ASCII property name.
 *
 * HTTP header values are Latin-1, and Node throws outright on anything else —
 * so `attachment; filename="Verdant Greens — Tower D"` is not a mangled
 * filename, it is a 500 and no download at all. Em dashes, curly quotes, ₹ and
 * Devanagari are all ordinary in these names, so this is the common case rather
 * than an edge one.
 *
 * RFC 6266 is the way out: a plain ASCII `filename` every client understands,
 * plus `filename*` carrying the real UTF-8 name for every client since roughly
 * 2011. Browsers prefer `filename*` when both are present.
 */
export function contentDisposition(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // encodeURIComponent leaves !'()* alone; RFC 5987's token set does not allow
  // them unencoded in this position, so they are escaped by hand.
  const encoded = encodeURIComponent(fileName)
    .replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** How many files the record has, for the "is this download worth starting" check. */
export async function countRecordMedia(recordId: string): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_attachment WHERE record_id = $1`,
    [recordId],
  );
  return row?.count ?? 0;
}

export interface ArchiveResult {
  /** Entries actually written. Zero means the record had no matching media. */
  files: number;
  /** Storage keys that metadata knew about but storage did not have. */
  missing: string[];
}

/**
 * Write the archive for one record into `out`. Resolves once the zip is
 * completely flushed.
 *
 * Callers should establish that the record has media *before* calling this:
 * once the first byte is on the wire the status code is already 200 and a
 * failure can only be signalled by breaking the connection. `countRecordMedia`
 * is the cheap check for that.
 */
export async function writeRecordArchive(
  recordId: string,
  moduleName: string,
  folderName: string,
  set: ArchiveSet,
  manifest: unknown,
  out: Writable,
): Promise<ArchiveResult> {
  const { rows } = await db.query<AttachmentRow>(
    // Same order the carousel and the share link use, so a zip somebody sends
    // by hand opens in the arrangement they curated rather than in upload
    // order — see core/media/ordering.ts.
    `SELECT id, file_name, mime_type, storage_key, variants, created_at
       FROM ipy_attachment
      WHERE record_id = $1
      ORDER BY ${photoOrderBy('')}, created_at`,
    [recordId],
  );

  const driver = await getDriver();
  const root = safeName(folderName, moduleName);
  const taken = new Set<string>();
  const cleanups: (() => Promise<void>)[] = [];
  const missing: string[] = [];
  let files = 0;

  const archive = new ZipArchive({ store: true });
  const finished = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    archive.on('warning', (err: ArchiverError) => {
      // ENOENT here is a file that vanished between the query and the read;
      // it is recorded in the manifest as missing rather than failing the
      // whole download for one absent object.
      if (err.code === 'ENOENT') logger.warn({ err, recordId }, 'archive: entry missing at read time');
      else reject(err);
    });
    out.on('error', reject);
    archive.on('end', () => resolve());
  });

  archive.pipe(out);

  try {
    for (const row of rows) {
      for (const entry of entriesFor(row, set)) {
        const temp = await driver.readToTempFile(entry.key);
        if (!temp) { missing.push(entry.key); continue; }
        cleanups.push(temp.cleanup);
        archive.file(temp.path, { name: uniquePath(taken, `${root}/${entry.folder}/${entry.name}`) });
        files += 1;
      }
    }

    // The manifest goes in last so it can report what was actually written —
    // including anything storage turned out not to have.
    archive.append(
      JSON.stringify({ ...(manifest as object), media: { files, set, missing } }, null, 2),
      { name: `${root}/property.json` },
    );

    await archive.finalize();
    await finished;
  } finally {
    // Only ever removes this driver's temp copies; the local driver's cleanup
    // is a no-op, so this cannot touch an original.
    await Promise.all(cleanups.map((fn) => fn().catch(() => undefined)));
  }

  return { files, missing };
}
