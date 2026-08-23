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
/**
 * The folders inside a property, relative to it.
 *
 * `{p}` is replaced with the unit, so every folder says which property it
 * belongs to even after somebody drags one out of the tree to share it.
 *
 * Only shapes that get posted are here. Pinterest's 2:3 and the 1.91:1 link
 * preview were removed because those platforms are not somewhere this business
 * sells, and a folder nobody opens is a folder somebody has to wonder about.
 */
export const PROPERTY_MEDIA_FOLDERS = {
  originals: '{p}-RAW-UPLOADS/PHOTOS',
  originalVideos: '{p}-RAW-UPLOADS/VIDEOS',

  // Named after the SHAPE, not the platform: five places want 4:5, and one file
  // is easier to keep straight than five identical copies. Which shape goes
  // where is answered by the descriptions file at the property root.
  shape4x5: '{p}-SHAPES/4x5',
  shape9x16: '{p}-SHAPES/9x16',
  shape1x1: '{p}-SHAPES/1x1',
  shape4x3: '{p}-SHAPES/4x3',
  shape16x9: '{p}-SHAPES/16x9',

  watermarked: '{p}-EDITED/WATERMARKED',
  thumbnails: '{p}-EDITED/THUMBNAILS',
  video: '{p}-VIDEO',
  // What the CRM and the public site take. 4:3 rather than a portrait crop: a
  // property page shows a room better wide, and it is the shape portals want.
  crmWebsite: '{p}-SHAPES/4x3',
  archive: '{p}-ARCHIVE',
} as const;

/**
 * The unit a folder key belongs to: `A1818-4bhk-250sqyd/...` -> `A1818`.
 *
 * Derived from the path rather than passed around, so every caller agrees
 * without having to thread the unit through.
 */
export function unitFromFolder(key: string): string {
  const first = key.split('/').filter(Boolean)[0] ?? '';
  return (first.split('-')[0] || 'PROPERTY').toUpperCase();
}

/**
 * The unit from a *folder key*, which is the folder itself rather than a file
 * inside it.
 *
 * The difference from `unitFromFolder` above is which end of the path to read,
 * and it matters: given `A1818-4bhk/A1818-RAW-UPLOADS/PHOTOS/img.jpg` the unit
 * is in the first segment, and given `A1818-4bhk` it is in the only one. Read
 * the wrong end of a file key and the unit comes out `IMG`.
 *
 * Both live here rather than one of them living privately in whatever file
 * needed it, because that is how there came to be two of these that disagreed
 * about a path with a slash in it and no way to notice.
 *
 * This one is the twin of `unit_of` in the media worker, which reads the same
 * folder name to decide what to call every file it writes.
 */
export function unitFromFolderName(folderKey: string): string {
  const last = folderKey.split('/').filter(Boolean).pop() ?? '';
  return (last.split('-')[0] || 'PROPERTY').toUpperCase();
}

/** Put the unit's name into a folder template. */
export function propertyFolder(template: string, unit: string): string {
  return template.replace('{p}', unit.toUpperCase());
}

/**
 * What `01 Originals` and friends were called before.
 *
 * Keys already written to storage still contain these, and no read resolves a
 * file by path, so nothing needs migrating. But `derivativeStorageKey` has to
 * recognise an old parent to strip it, or a derivative of a pre-rename photo
 * lands one level too deep and the zip export loses it.
 */
const LEGACY_ORIGINALS = ['01 Originals', '01_RAW_UPLOADS/PHOTOS'];

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
/** Every folder a property gets, in the order somebody reads them. */
export function propertyFolderTree(unit: string): string[] {
  return [
    PROPERTY_MEDIA_FOLDERS.originals,
    PROPERTY_MEDIA_FOLDERS.originalVideos,
    PROPERTY_MEDIA_FOLDERS.shape4x5,
    PROPERTY_MEDIA_FOLDERS.shape9x16,
    PROPERTY_MEDIA_FOLDERS.shape1x1,
    PROPERTY_MEDIA_FOLDERS.shape4x3,
    PROPERTY_MEDIA_FOLDERS.shape16x9,
    PROPERTY_MEDIA_FOLDERS.watermarked,
    PROPERTY_MEDIA_FOLDERS.thumbnails,
    PROPERTY_MEDIA_FOLDERS.video,
    PROPERTY_MEDIA_FOLDERS.archive,
  ].map((t) => propertyFolder(t, unit));
}

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

/**
 * How a property folder is named: `A1818-4bhk-250sqyd`.
 *
 * The unit stays upper case because that is how it is said on the phone and
 * written on the door; everything after it is lower case so the name is one
 * readable string rather than shouting. Only facts that are actually filled in
 * appear, so a thin record gets a short name rather than a row of hyphens.
 */
export function propertyFolderName(parts: {
  unit: string;
  configuration?: string | null;
  plotArea?: number | null;
  areaUnit?: string | null;
}): string {
  const unit = slug(parts.unit, 24).toUpperCase();
  const tail = [
    parts.configuration ? slug(parts.configuration, 16).replace(/-/g, '') : null,
    parts.plotArea ? `${Math.round(parts.plotArea)}${slug(parts.areaUnit ?? 'sqyd', 8).replace(/-/g, '')}` : null,
  ].filter(Boolean);
  return [unit, ...tail].join('-') || unit || 'PROPERTY';
}

/**
 * Stable root for everything belonging to one CRM record.
 *
 * Property folders live at the top of the drive rather than under a
 * `properties/` folder. There is only one kind of thing in there, so the extra
 * level was a directory somebody had to click through every single time to
 * reach the folder they actually wanted.
 */
export function recordStorageRoot(
  moduleName: string,
  recordNumber: string | null,
  label: string,
  recordId: string,
): string {
  const folder = recordFolder(recordNumber, label, recordId);
  return moduleName === 'properties' ? folder : `${slug(moduleName, 32)}/${folder}`;
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
  // Whatever unit this key belongs to, so the templated drop boxes resolve to
  // the real folder names before they are compared.
  const keyUnit = unitFromFolder(originalKey);
  const dropBoxes = [
    propertyFolder(PROPERTY_MEDIA_FOLDERS.originals, keyUnit),
    propertyFolder(PROPERTY_MEDIA_FOLDERS.originalVideos, keyUnit),
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
    const unit = unitFromFolder(root);
    return `${root}/${propertyFolder(PROPERTY_MEDIA_FOLDERS.originals, unit)}/${stem}-${unique}${ext}`;
  }

  return `${root}/${stem}-${unique}${ext}`;
}

/**
 * The folder name for one property, read from the property itself.
 *
 * This is the half that was missing. `propertyFolderName` above has always
 * described the intended shape — `A1818-4bhk-250sqyd` — and the media worker
 * splits on the first hyphen to learn the unit, because every folder and every
 * file inside is named after it. Nothing ever called it. Folder creation used
 * the generic `recordStorageRoot`, which builds a name out of the record
 * number, and property record numbers all start `UNIT-`.
 *
 * The result was that every property in the drive had identically named
 * insides: `UNIT-RAW-UPLOADS`, `UNIT-SHAPES`, `UNIT-PROPERTY DETAILS.txt`, and
 * every photo the worker wrote came out `UNIT-01.jpg`. Nothing broke, because
 * both sides were wrong in the same way and still found each other. It just
 * threw away the one thing the name was for: knowing whose folder you are
 * looking at.
 *
 * The unit is the property's own unit number when it has one and its name
 * otherwise, because "B1100" is what he types as the name and what is written
 * on the door.
 */
export async function propertyFolderKey(recordId: string): Promise<string | null> {
  const { db } = await import('../../db/pool.js');
  const row = await db.queryOne<{
    label: string; is_deleted: boolean; module_name: string;
    unit_number: string | null; configuration: string | null;
    plot_area: string | number | null; area_unit: string | null;
  }>(
    `SELECT r.label, r.is_deleted, r.module_name,
            p.unit_number, p.configuration, p.plot_area, p.area_unit
       FROM ipy_record r
       LEFT JOIN ipy_e_properties p ON p.record_id = r.id
      WHERE r.id = $1`,
    [recordId],
  );
  if (!row || row.is_deleted || row.module_name !== 'properties') return null;

  return propertyFolderName({
    unit: row.unit_number?.trim() || row.label,
    configuration: row.configuration,
    plotArea: row.plot_area === null ? null : Number(row.plot_area),
    areaUnit: row.area_unit,
  });
}
