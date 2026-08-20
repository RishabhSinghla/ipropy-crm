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
 * every module maintains, rather than by anything property-shaped. Leads get
 * the same treatment for free.
 *
 * Nothing migrates. Existing rows keep their old keys and keep working: every
 * read goes through `ipy_attachment.storage_key`, and no route resolves a file
 * by path.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../db/pool.js';

/**
 * The folder names, which are the owner's, not this codebase's.
 *
 * He had already designed a structure in OneDrive by hand and the CRM was
 * writing a different one beside it — three competing conventions in one drive,
 * which is the filesystem version of the duplicated-list bug this project keeps
 * paying for. His numbering wins because his team reads it every day.
 *
 * Only the folders the pipeline actually fills are here. His full design runs to
 * several hundred folders covering portals, blog and distribution; creating all
 * of them up front would mean a property whose folder tree is mostly empty
 * promises, and an empty folder is indistinguishable from a step that failed.
 * They can be added as the work that fills them is built.
 */
export const PROPERTY_MEDIA_FOLDERS = {
  data: '00_PROPERTY_DATA',
  originals: '01_RAW_UPLOADS/PHOTOS',
  originalVideos: '01_RAW_UPLOADS/VIDEOS',
  compressed: '03_EDITED_MEDIA/CLEAN',
  watermarked: '03_EDITED_MEDIA/WATERMARKED',
  thumbnails: '03_EDITED_MEDIA/THUMBNAILS',
  instagramFeed: '04_SOCIAL/INSTAGRAM/FEED',
  instagramStory: '04_SOCIAL/INSTAGRAM/STORIES',
  facebook: '04_SOCIAL/FACEBOOK',
  whatsapp: '04_SOCIAL/WHATSAPP',
  googleBusiness: '04_SOCIAL/GOOGLE_BUSINESS',
  // Where an Indian buyer actually searches: 99acres, Housing, Magicbricks,
  // NoBroker, OLX. They all want landscape and every social shape wants
  // portrait, so this is the one shape the pipeline produced nothing for.
  portals: '05_PORTALS',
  crmWebsite: '07_WEBSITE',
  archive: '99_ARCHIVE',
} as const;

/**
 * What `01 Originals` and friends were called before.
 *
 * Keys already written to storage still contain these, and no read resolves a
 * file by path, so nothing needs migrating. But `derivativeStorageKey` has to
 * recognise an old parent to strip it, or a derivative of a pre-rename photo
 * lands one level too deep and the zip export loses it.
 */
const LEGACY_ORIGINALS = ['01 Originals'];

/**
 * What the CRM creates when a property is made.
 *
 * All of them, up front. The team drops originals into `01 Originals` by hand
 * and presses Finish; n8n writes the processed sets into the rest. A workflow
 * that has to create a folder before it can write to it fails in a way nobody
 * can read — "item not found" on an upload, halfway through a property.
 *
 * This used to create only the drop box, on the reasoning that an absent folder
 * says "not processed yet" without ambiguity. That was right when the CRM did
 * the processing and could be trusted to make each folder as it filled it. It
 * is wrong now that the work happens elsewhere: the folders are the contract
 * between the CRM and n8n, and a contract you have to create on first use is
 * one that breaks on first use.
 */
export const PROPERTY_MEDIA_FOLDER_TREE = [
  PROPERTY_MEDIA_FOLDERS.data,
  PROPERTY_MEDIA_FOLDERS.originals,
  PROPERTY_MEDIA_FOLDERS.originalVideos,
  PROPERTY_MEDIA_FOLDERS.compressed,
  PROPERTY_MEDIA_FOLDERS.watermarked,
  PROPERTY_MEDIA_FOLDERS.thumbnails,
  PROPERTY_MEDIA_FOLDERS.instagramFeed,
  PROPERTY_MEDIA_FOLDERS.instagramStory,
  PROPERTY_MEDIA_FOLDERS.facebook,
  PROPERTY_MEDIA_FOLDERS.whatsapp,
  PROPERTY_MEDIA_FOLDERS.googleBusiness,
  PROPERTY_MEDIA_FOLDERS.portals,
  PROPERTY_MEDIA_FOLDERS.crmWebsite,
  PROPERTY_MEDIA_FOLDERS.archive,
];

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
export function recordFolder(recordNumber: string | null, label: string, recordId: string): string {
  const parts = [slug(recordNumber ?? '', 24), slug(label, 48)].filter(Boolean);
  const name = parts.join('-');
  return name || recordId.slice(0, 8);
}

/** Stable root for everything belonging to one CRM record. */
export function recordStorageRoot(
  moduleName: string,
  recordNumber: string | null,
  label: string,
  recordId: string,
): string {
  return `${slug(moduleName, 32)}/${recordFolder(recordNumber, label, recordId)}`;
}

/**
 * Put a derivative in its named human-facing folder.
 *
 * Existing pre-migration keys did not contain `01 Originals`; they still map
 * safely by treating their current parent as the record root.
 */
export function derivativeStorageKey(
  originalKey: string,
  destination: string,
  suffix: string,
  extension: string,
): string {
  const parts = originalKey.split('/').filter(Boolean);
  const file = parts.pop() ?? 'file';

  // `originals` is a nested path now (`01_RAW_UPLOADS/PHOTOS`), so stripping one
  // trailing segment is no longer enough — a derivative of a photo would land
  // inside `01_RAW_UPLOADS/` rather than beside the other sets. Strip whichever
  // known drop-box the key ends with, old name or new, longest first so a
  // multi-segment match is preferred over a single-segment one.
  const dropBoxes = [
    PROPERTY_MEDIA_FOLDERS.originals,
    PROPERTY_MEDIA_FOLDERS.originalVideos,
    ...LEGACY_ORIGINALS,
  ].sort((a, b) => b.split('/').length - a.split('/').length);

  for (const box of dropBoxes) {
    const segments = box.split('/');
    if (parts.length >= segments.length
      && parts.slice(-segments.length).join('/') === box) {
      parts.splice(-segments.length);
      break;
    }
  }
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `${parts.join('/')}/${destination}/${stem}-${suffix}${ext}`;
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
    ? await db.queryOne<{ module_name: string; label: string; record_number: string | null; folder_key: string | null }>(
      `SELECT r.module_name, r.label, r.record_number, ps.folder_key
         FROM ipy_record r
         LEFT JOIN ipy_property_storage ps ON ps.record_id = r.id
        WHERE r.id = $1`,
      [recordId],
    )
    : null;

  // No record — an upload that has not been attached to anything. Keep the old
  // month grouping so these stay browsable and do not pile into one directory.
  if (!record) {
    return `unfiled/${new Date().toISOString().slice(0, 7)}/${stem}-${unique}${ext}`;
  }

  const root = record.folder_key
    ?? recordStorageRoot(record.module_name, record.record_number, record.label, recordId!);

  if (record.module_name === 'properties') {
    // Whichever runs first — folder worker or upload — permanently chooses the
    // same root. Renaming a property later cannot split its media in two.
    await db.query(
      `INSERT INTO ipy_property_storage (record_id, folder_key)
       VALUES ($1,$2)
       ON CONFLICT (record_id) DO UPDATE
         SET folder_key = COALESCE(ipy_property_storage.folder_key, EXCLUDED.folder_key),
             updated_at = now()`,
      [recordId, root],
    );
    return `${root}/${PROPERTY_MEDIA_FOLDERS.originals}/${stem}-${unique}${ext}`;
  }

  return `${root}/${stem}-${unique}${ext}`;
}
