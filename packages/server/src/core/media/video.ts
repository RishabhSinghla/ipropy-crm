/**
 * Video derivatives: one web-optimized transcode with a watermark, and
 * nothing else.
 *
 * Self-hosted via ffmpeg — no cloud video-AI API, no per-video cost (confirmed
 * with the user). What this deliberately no longer does is decorate: the
 * branded title card and the background music bed are gone, because a clip
 * that is going to be cut in a real video editor gains nothing from an intro
 * this process glued on, and both stages cost ffmpeg time on every upload.
 *
 * Same graceful-degradation shape as ai/client.ts: if ffmpeg isn't on PATH,
 * this logs once and returns null forever after — the original video keeps
 * serving exactly as it does today, nothing breaks.
 *
 * The original is read via StorageDriver.readToTempFile(), never buffered
 * into process memory — a phone video can be well over a GB.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import ffmpeg from 'fluent-ffmpeg';
import type { StorageDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import { watermarkFor } from './watermark.js';
import { derivativeStorageKey, PROPERTY_MEDIA_FOLDERS } from '../storage/keys.js';

const execFileAsync = promisify(execFile);

let ffmpegAvailable: boolean | null = null;
async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    logger.warn('ffmpeg not found on PATH — video uploads will be served as their original, unprocessed, and HEIC photos will get no derivatives. Install ffmpeg to enable video transcoding and HEIC decoding.');
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

export async function processVideo(
  driver: StorageDriver,
  attachmentId: string,
  storageKey: string,
  inputPath: string,
): Promise<Record<string, string> | null> {
  if (!(await isFfmpegAvailable())) return null;

  const work = await mkdtemp(join(tmpdir(), 'ipropy-video-'));
  try {
    // A probe that finds no video stream means this is not something ffmpeg can
    // usefully re-encode — an audio file with a video mime type, or a corrupt
    // upload. Better to serve the original than to write a broken derivative.
    const { width, height } = await probe(inputPath);
    if (!width || !height) {
      logger.warn({ attachmentId }, 'media job: could not read video dimensions, skipping processing');
      return null;
    }

    const watermarked = join(work, 'watermarked.mp4');
    await scaleAndWatermark(inputPath, watermarked);

    const key = derivativeStorageKey(storageKey, PROPERTY_MEDIA_FOLDERS.crmWebsite, 'web', '.mp4');
    await driver.save(key, createReadStream(watermarked), 'video/mp4');
    return { web: key };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

interface Probe { width: number; height: number }

function probe(path: string): Promise<Probe> {
  return new Promise((resolvePromise, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      const v = data.streams.find((s) => s.codec_type === 'video');
      resolvePromise({ width: v?.width ?? 0, height: v?.height ?? 0 });
    });
  });
}

/** Caps the longer side at 1920 (never upscales), overlays the watermark bottom-right throughout, re-encodes for web (faststart H.264/AAC). */
async function scaleAndWatermark(inputPath: string, outputPath: string): Promise<void> {
  // Reference width for the watermark's proportions; the overlay filter's
  // W/H expressions below position it correctly regardless of the actual
  // (possibly portrait) output size — see watermark.ts.
  // 1920x1080 is the nominal capped frame, not a measurement — the overlay's
  // W/H expressions place the badge correctly whatever the real output is. At
  // this size the badge always fits, so the null branch is unreachable; it is
  // handled rather than asserted because "cannot happen" ages badly and an
  // unwatermarked clip is a far better outcome than a failed job.
  const wm = await watermarkFor(1920, 1080);

  if (!wm) {
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-vf', `scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart',
      outputPath,
    ]);
    return;
  }

  const wmPath = join(tmpdir(), `ipropy-wm-${Date.now()}.png`);
  await writeFile(wmPath, wm.buffer);

  try {
    await runFfmpeg([
      '-y', '-i', inputPath, '-i', wmPath,
      '-filter_complex',
      `[0:v]scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease[scaled];[scaled][1:v]overlay=W-w-${wm.margin}:H-h-${wm.margin}[out]`,
      '-map', '[out]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart',
      outputPath,
    ]);
  } finally {
    await rm(wmPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Runs ffmpeg directly via execFile rather than through fluent-ffmpeg's
 * fluent API. fluent-ffmpeg validates every `-f <name>` input format against
 * its own cached `ffmpeg -formats` capability list before it will let a
 * command run, and on this stack that check rejects formats the installed
 * binary supports perfectly well — confirmed by running the equivalent command
 * directly at the CLI. Going straight to execFile sidesteps that validation
 * layer, which also makes the exact command being run explicit.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) return reject(err);
      resolvePromise();
    });
  });
}
