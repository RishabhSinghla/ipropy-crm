/**
 * Shrink a photo in the browser before it is uploaded.
 *
 * A phone camera writes 8–15MB per shot. Nothing in this CRM ever displays
 * more than 1600px on the long edge — that is the largest derivative the
 * server makes — and a buyer views them on a phone. So the pixels above that
 * are paid for in upload time, in storage, and in every future download, and
 * seen by nobody.
 *
 * **This is not lossless, and calling it that would be a lie.** Lossless
 * re-encoding of a JPEG saves 5–20%. The 90% comes from resizing and
 * re-encoding, which is lossy. It is *visually* lossless at these settings:
 * 2560px is still wider than the biggest thing the CRM renders, and quality
 * 0.82 is above the point where JPEG artefacts become visible on a photograph.
 *
 * Three ways this declines to act, all of them returning the original file so
 * an upload never fails because compression did:
 *
 *  - the browser cannot decode it (HEIC is the one that matters — Safari can,
 *    Chrome cannot, and an iPhone set to "Most Compatible" sends JPEG anyway)
 *  - the result is not meaningfully smaller, which is what happens to a photo
 *    somebody already compressed, and to most screenshots
 *  - anything at all throws
 */

export interface CompressResult {
  file: File;
  originalBytes: number;
  finalBytes: number;
  /** False when the original was kept, whatever the reason. */
  compressed: boolean;
}

export interface CompressOptions {
  /** Long edge in pixels. Above the CRM's largest derivative (1600) on purpose. */
  maxEdge?: number;
  quality?: number;
  /** Skip unless the result saves at least this share of the bytes. */
  minSaving?: number;
}


/**
 * Move the original's EXIF block into the re-encoded JPEG.
 *
 * This is load-bearing, not a nicety. Site capture files a photo against a
 * property by its `DateTimeOriginal`, matched into the time window of a shoot
 * session — location is deliberately not used, because adjacent builder floors
 * are metres apart and well inside a phone's GPS error. Canvas re-encoding
 * drops every tag, so compressing without this would hand the server a photo
 * with no capture time and it would be filed against the wrong visit, or none.
 * Nothing would error; the photos would just quietly land in the wrong place.
 *
 * A JPEG is 0xFFD8 followed by marker segments. EXIF lives in APP1 (0xFFE1).
 * Copying that one segment from the original to just after the new file's SOI
 * is the whole job — the canvas output has no APP1 of its own to conflict with.
 */
function withExif(originalBytes: ArrayBuffer, encoded: ArrayBuffer): Blob | null {
  const src = new DataView(originalBytes);
  if (src.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  let app1: ArrayBuffer | null = null;
  while (offset + 4 <= src.byteLength) {
    if (src.getUint8(offset) !== 0xff) break;
    const marker = src.getUint8(offset + 1);
    // Start of scan: pixel data begins, no more metadata to find.
    if (marker === 0xda) break;
    const length = src.getUint16(offset + 2);
    if (length < 2) break;
    if (marker === 0xe1) {
      app1 = originalBytes.slice(offset, offset + length + 2);
      break;
    }
    offset += 2 + length;
  }
  if (!app1) return null;

  const out = new Uint8Array(encoded);
  if (out[0] !== 0xff || out[1] !== 0xd8) return null;
  return new Blob([out.slice(0, 2).buffer, app1, out.slice(2).buffer], { type: 'image/jpeg' });
}

export async function compressImage(
  file: File,
  { maxEdge = 2560, quality = 0.82, minSaving = 0.1 }: CompressOptions = {},
): Promise<CompressResult> {
  const keep = (): CompressResult => ({
    file, originalBytes: file.size, finalBytes: file.size, compressed: false,
  });

  if (!file.type.startsWith('image/')) return keep();
  // A PNG is usually a screenshot, a logo or a floor plan. Re-encoding one as
  // JPEG puts ringing around every hard edge and around text, which is exactly
  // what those images are made of.
  if (file.type === 'image/png') return keep();

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > maxEdge ? maxEdge / longest : 1;

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return keep(); }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const encoded = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });
    if (!encoded) return keep();

    // Carried across before the size check, since the EXIF block is a couple of
    // KB and could in principle tip a marginal case either way.
    let blob: Blob = encoded;
    if (file.type === 'image/jpeg') {
      try {
        const withTags = withExif(await file.arrayBuffer(), await encoded.arrayBuffer());
        if (withTags) blob = withTags;
      } catch {
        // A photo that keeps its pixels and loses its tags is still worse than
        // one that keeps both, so an unreadable header means no compression at
        // all rather than a silently untimed photo.
        return keep();
      }
    }

    if (blob.size > file.size * (1 - minSaving)) return keep();

    // Extension follows the new format. A file called .heic holding JPEG bytes
    // confuses everything downstream that trusts the name.
    const base = file.name.replace(/\.[^.]+$/, '');
    return {
      file: new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified }),
      originalBytes: file.size,
      finalBytes: blob.size,
      compressed: true,
    };
  } catch {
    return keep();
  }
}

/** "12.4 MB" — for telling somebody what was actually saved. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
