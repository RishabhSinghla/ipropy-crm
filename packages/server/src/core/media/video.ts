/**
 * Video derivatives: web-optimized transcode, a persistent watermark
 * overlay, an auto-generated title card from live property data, and an
 * optional quiet background music bed. Self-hosted via ffmpeg — no cloud
 * video-AI API, no per-video cost (confirmed with the user).
 *
 * Same graceful-degradation shape as ai/client.ts: if ffmpeg isn't on PATH,
 * this logs once and returns null forever after — the original video keeps
 * serving exactly as it does today, nothing breaks. Every optional stage
 * (title card, music) independently no-ops when its inputs aren't there.
 *
 * The original is read via StorageDriver.readToTempFile(), never buffered
 * into process memory — a phone video can be well over a GB.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import type { StorageDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import { watermarkFor } from './watermark.js';
import { derivativeStorageKey, PROPERTY_MEDIA_FOLDERS } from '../storage/keys.js';

const execFileAsync = promisify(execFile);

export interface TitleCardInfo {
  title: string;
  subtitle?: string;
  price?: string;
}

// A track dropped in at this path gets mixed under the final video at low
// volume. None is bundled — see PROJECT_HANDOVER.md §14 for why (licensing:
// nothing gets embedded without a confirmed source). Missing file → this
// stage is silently skipped, everything else proceeds normally. Anchored to
// this module's own location (not process.cwd(), which is packages/server
// in dev via tsx but /app at the repo root in the Docker image) — this
// resolves the same way from both src/core/media (dev) and dist/core/media
// (prod), landing on packages/server/assets/music either way.
const MUSIC_TRACK_PATH = fileURLToPath(new URL('../../../assets/music/background.mp3', import.meta.url));
const TITLE_CARD_SECONDS = 3;
const MUSIC_VOLUME = 0.16;

let ffmpegAvailable: boolean | null = null;
async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    logger.warn('ffmpeg not found on PATH — video uploads will be served as their original, unprocessed. Install ffmpeg to enable transcode/watermark/title-card/music.');
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function processVideo(
  driver: StorageDriver,
  attachmentId: string,
  storageKey: string,
  inputPath: string,
  titleCard: TitleCardInfo | null,
): Promise<Record<string, string> | null> {
  if (!(await isFfmpegAvailable())) return null;

  const work = await mkdtemp(join(tmpdir(), 'ipropy-video-'));
  try {
    const sourceProbe = await probe(inputPath);
    if (!sourceProbe.width || !sourceProbe.height) {
      logger.warn({ attachmentId }, 'media job: could not read video dimensions, skipping processing');
      return null;
    }

    const watermarked = join(work, 'watermarked.mp4');
    await scaleAndWatermark(inputPath, watermarked);

    let withTitleCard = watermarked;
    if (titleCard) {
      try {
        const dims = await probe(watermarked);
        const clip = join(work, 'titlecard.mp4');
        await makeTitleCardClip(work, dims, titleCard, clip);
        const concatenated = join(work, 'with-title.mp4');
        await concatClips([clip, watermarked], concatenated, work);
        withTitleCard = concatenated;
      } catch (err) {
        // The video itself is still good without a title card — don't fail the whole job over this.
        logger.warn({ err, attachmentId }, 'media job: title card generation failed, continuing without it');
      }
    }

    let final = withTitleCard;
    if (await fileExists(MUSIC_TRACK_PATH)) {
      try {
        const mixed = join(work, 'final.mp4');
        await mixMusic(withTitleCard, MUSIC_TRACK_PATH, mixed, sourceProbe.hasAudio);
        final = mixed;
      } catch (err) {
        logger.warn({ err, attachmentId }, 'media job: music mix failed, continuing without it');
      }
    }

    const key = derivativeStorageKey(storageKey, PROPERTY_MEDIA_FOLDERS.crmWebsite, 'web', '.mp4');
    await driver.save(key, createReadStream(final), 'video/mp4');
    return { web: key };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

interface Probe { width: number; height: number; fps: number; hasAudio: boolean }

function probe(path: string): Promise<Probe> {
  return new Promise((resolvePromise, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      const v = data.streams.find((s) => s.codec_type === 'video');
      const a = data.streams.find((s) => s.codec_type === 'audio');
      const [num, den] = (v?.r_frame_rate ?? '30/1').split('/').map(Number);
      resolvePromise({
        width: v?.width ?? 0,
        height: v?.height ?? 0,
        fps: den ? Math.round(num / den) || 30 : 30,
        hasAudio: Boolean(a),
      });
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

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function renderTitleCardPng(width: number, height: number, info: TitleCardInfo): Promise<Buffer> {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#191510"/>
    <text x="${width * 0.06}" y="${height * 0.16}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(height * 0.045)}" letter-spacing="3" fill="#f3ede1">IPROPY</text>
    <text x="${width * 0.06}" y="${height * 0.5}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(height * 0.09)}" fill="#f3ede1">${escapeXml(info.title)}</text>
    ${info.subtitle ? `<text x="${width * 0.06}" y="${height * 0.61}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(height * 0.04)}" fill="#c9bfab">${escapeXml(info.subtitle)}</text>` : ''}
    ${info.price ? `<text x="${width * 0.06}" y="${height * 0.82}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(height * 0.06)}" fill="#d99b4e">${escapeXml(info.price)}</text>` : ''}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Runs ffmpeg directly via execFile rather than through fluent-ffmpeg's
 * fluent API. fluent-ffmpeg validates every `-f <name>` input format against
 * its own cached `ffmpeg -formats` capability list before it will let a
 * command run, and on this stack that check rejects `lavfi` (the virtual
 * device the title card's silent-audio track needs) even though the
 * installed ffmpeg binary supports it fine — confirmed by running the
 * equivalent command directly at the CLI. Going straight to execFile
 * sidesteps that validation layer entirely for every step here, which also
 * makes the exact command being run explicit and easy to reason about.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) return reject(err);
      resolvePromise();
    });
  });
}

/** A short still-image clip at the exact resolution/fps of the main video, so the concat demuxer's `-c copy` can join them without re-encoding. */
async function makeTitleCardClip(work: string, dims: Probe, info: TitleCardInfo, outputPath: string): Promise<void> {
  const png = await renderTitleCardPng(dims.width, dims.height, info);
  const pngPath = join(work, 'titlecard.png');
  await writeFile(pngPath, png);

  await runFfmpeg([
    '-y',
    '-loop', '1', '-i', pngPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', String(TITLE_CARD_SECONDS),
    '-r', String(dims.fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    outputPath,
  ]);
}

async function concatClips(clips: string[], outputPath: string, work: string): Promise<void> {
  const listPath = join(work, 'concat.txt');
  await writeFile(listPath, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
}

async function mixMusic(inputPath: string, musicPath: string, outputPath: string, hasOriginalAudio: boolean): Promise<void> {
  const filter = hasOriginalAudio
    ? [`[1:a]volume=${MUSIC_VOLUME}[music]`, '[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[mixedaudio]'].join(';')
    : `[1:a]volume=${MUSIC_VOLUME}[mixedaudio]`;
  await runFfmpeg([
    '-y', '-i', inputPath, '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[mixedaudio]',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    outputPath,
  ]);
}
