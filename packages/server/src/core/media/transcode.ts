/** Decode HEIC/HEIF to a high-quality temporary JPEG for Sharp derivatives. */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';

// The prebuilt libvips behind Sharp often has HEIF container support but no
// licensed HEVC decoder. Match the MIME type explicitly so a corrupt JPEG is
// not pointlessly retried through ffmpeg.
const NEEDS_TRANSCODE = /^image\/(heic|heif|heic-sequence|heif-sequence)$/i;

export function needsTranscode(mimeType: string): boolean {
  return NEEDS_TRANSCODE.test(mimeType.trim());
}

/**
 * The original remains untouched in 01 Originals. This JPEG exists only for
 * milliseconds and becomes the pixel source for WebP/CRM/social derivatives.
 */
export async function transcodeToJpeg(input: Buffer, attachmentId?: string): Promise<Buffer | null> {
  const work = await mkdtemp(join(tmpdir(), 'ipropy-heic-'));
  try {
    const source = join(work, 'source.heic');
    const output = join(work, 'out.jpg');
    await writeFile(source, input);

    // One still only: a HEIC may also contain a burst or Live Photo motion.
    await run([
      '-y', '-loglevel', 'error', '-i', source,
      '-frames:v', '1', '-f', 'image2', '-q:v', '2', output,
    ]);
    return await readFile(output);
  } catch (err) {
    logger.warn({ err, attachmentId }, 'media job: could not decode HEIC — preserving the original only');
    return null;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolvePromise();
    });
  });
}
