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

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });
    if (!blob) return keep();

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
