/**
 * Where an uploaded file actually lands in storage.
 *
 * Keys used to be `2026-08/<uuid>.heic`: unique, and meaningless. That is fine
 * while storage is something only the server reads, and wrong the moment anyone
 * mirrors the bucket to a laptop — an rclone copy of that is a folder of UUIDs,
 * which is exactly the pile this system exists to replace. So the key is
 * derived from the record instead:
 *
 *   properties/unit-00044-verdant-greens-tower-d/img_9001-4f2a91c3.heic
 *   properties/unit-00044-verdant-greens-tower-d/img_9001-4f2a91c3-large.webp
 *
 * Derivatives are deliberately siblings rather than living in their own folder:
 * images.ts and video.ts build their keys by appending to the original's base,
 * so this keeps everything for one photo together and needs no change there.
 * The zip export (core/media/archive.ts) is what sorts them into
 * originals/branded/web for a human, and it works off `variants`, not the path.
 *
 * Deliberately generic — driven by `ipy_record.label` and `record_number`, which
 * every module maintains, rather than by anything property-shaped. Leads and
 * campaigns get the same treatment for free.
 *
 * Nothing migrates. Existing rows keep their old keys and keep working: every
 * read goes through `ipy_attachment.storage_key`, and no route resolves a file
 * by path.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../db/pool.js';

/**
 * Lowercase, hyphen-joined, ASCII only.
 *
 * Slugs rather than the pretty name on purpose: these are object-store keys and
 * rclone paths, so they should stay free of spaces and of anything a shell, a
 * URL or Windows would want escaped. The readable-with-capitals-and-spaces
 * version is what the zip export produces.
 *
 * NFKD then stripping combining marks folds accented Latin down to something
 * useful ("Café" → "cafe"). A script with no ASCII form at all — Devanagari,
 * say — slugs to empty, which callers handle by falling back to the record id
 * rather than producing a nameless folder.
 */
export function slug(input: string, max = 48): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** `IMG_9001.HEIC` → `img_9001`, capped. Underscores survive; they read fine. */
function fileStem(originalName: string, ext: string): string {
  const base = ext && originalName.toLowerCase().endsWith(ext.toLowerCase())
    ? originalName.slice(0, originalName.length - ext.length)
    : originalName;
  return slug(base.replace(/_/g, '-'), 60);
}

/**
 * The folder for one record: `unit-00044-verdant-greens-tower-d`.
 *
 * Record number first so the folder sorts and searches by the code somebody
 * actually quotes on the phone. Either half may be missing — a record can have
 * no numbering scheme, and a label can be entirely non-Latin — so the id is the
 * backstop that guarantees a non-empty, unique-enough folder.
 */
function recordFolder(recordNumber: string | null, label: string, recordId: string): string {
  const parts = [slug(recordNumber ?? '', 24), slug(label, 48)].filter(Boolean);
  const name = parts.join('-');
  return name || recordId.slice(0, 8);
}

export interface KeyRequest {
  /** Null for an upload not attached to anything yet. */
  recordId: string | null;
  originalName: string;
  /** Already validated by the caller (`SAFE_EXT`), including the dot. May be ''. */
  ext: string;
}

/**
 * Build the storage key for a new upload.
 *
 * The random tail is not decoration. Two photos off the same phone are honestly
 * both called IMG_9001.jpg, and without it the second `save()` would silently
 * overwrite the first — a checked-then-written scheme would still race two
 * concurrent uploads. Eight hex characters after a name that is still obviously
 * IMG_9001 is a good trade for never losing a photo.
 */
export async function buildStorageKey({ recordId, originalName, ext }: KeyRequest): Promise<string> {
  const stem = fileStem(originalName, ext) || 'file';
  const unique = randomUUID().slice(0, 8);

  const record = recordId
    ? await db.queryOne<{ module_name: string; label: string; record_number: string | null }>(
      `SELECT module_name, label, record_number FROM ipy_record WHERE id = $1`,
      [recordId],
    )
    : null;

  // No record — an upload that has not been attached to anything. Keep the old
  // month grouping so these stay browsable and do not pile into one directory.
  if (!record) {
    return `unfiled/${new Date().toISOString().slice(0, 7)}/${stem}-${unique}${ext}`;
  }

  const folder = recordFolder(record.record_number, record.label, recordId!);
  return `${slug(record.module_name, 32)}/${folder}/${stem}-${unique}${ext}`;
}
