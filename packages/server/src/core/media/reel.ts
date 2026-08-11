/**
 * Reels — a listing's photos become a 9:16 video, server-side, with ffmpeg.
 *
 * This is the honest answer to "video editing". A general timeline editor is
 * months of work and nobody at a property desk wants one; what they want is the
 * eight photos they already uploaded turned into something postable, with the
 * price on it, before the enquiry goes cold.
 *
 * So: each photo gets a slow pan-and-zoom (the Ken Burns effect — a still image
 * that drifts reads as video, a still image that sits there reads as a
 * mistake), a caption, a crossfade into the next, a title card at the front and
 * a call-to-action at the end.
 *
 * Every stage degrades on its own, the same way `video.ts` does. No ffmpeg
 * means the job is marked `unsupported` rather than failed, because a missing
 * binary is an operations fact, not a broken request — and the UI says so
 * instead of showing a red error the user cannot act on.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { getDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import { watermarkFor } from './watermark.js';

const execFileAsync = promisify(execFile);

export interface ReelSlide {
  /** Storage key of the source photo. */
  key?: string;
  /** Absolute or API URL, used when the photo is not in our storage. */
  url?: string;
  caption?: string;
}

export interface ReelSpec {
  slides: ReelSlide[];
  title: string;
  subtitle?: string;
  price?: string;
  cta?: string;
  brandColour?: string;
  /** Seconds each photo is on screen, transition included. */
  secondsPerSlide?: number;
  width?: number;
  height?: number;
  music?: boolean;
}

const DEFAULTS = {
  secondsPerSlide: 3,
  width: 1080,
  height: 1920,
  brandColour: '#d99b4e',
};

/** Crossfade length. Long enough to read as deliberate, short enough not to eat the slide. */
const FADE = 0.5;
const TITLE_SECONDS = 2.5;
const OUTRO_SECONDS = 2.5;
const MUSIC_TRACK_PATH = fileURLToPath(new URL('../../../assets/music/background.mp3', import.meta.url));
const MUSIC_VOLUME = 0.16;

let ffmpegAvailable: boolean | null = null;

export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    logger.warn('ffmpeg not found on PATH — reel rendering is unavailable. Install ffmpeg to enable it.');
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

export async function isReelMusicAvailable(): Promise<boolean> {
  try {
    await stat(MUSIC_TRACK_PATH);
    return true;
  } catch {
    return false;
  }
}

export interface ReelResult {
  key: string;
  mime: string;
  durationSeconds: number;
}

export async function renderReel(spec: ReelSpec, jobId: string): Promise<ReelResult | null> {
  if (!(await isFfmpegAvailable())) return null;
  if (!spec.slides.length) throw new Error('A reel needs at least one photo');

  const width = spec.width ?? DEFAULTS.width;
  const height = spec.height ?? DEFAULTS.height;
  const perSlide = Math.max(1.5, spec.secondsPerSlide ?? DEFAULTS.secondsPerSlide);
  const brand = spec.brandColour ?? DEFAULTS.brandColour;

  const work = await mkdtemp(join(tmpdir(), 'ipropy-reel-'));
  const driver = await getDriver();
  try {
    // --- 1. normalise every photo to the exact canvas ----------------------
    // ffmpeg's zoompan is fussy about mismatched inputs, and a portrait phone
    // photo next to a landscape one otherwise produces a jumping frame. Doing
    // the fit in sharp first means the video filter only ever sees one size.
    const frames: { path: string; slide: ReelSlide }[] = [];
    for (const [index, slide] of spec.slides.entries()) {
      const buffer = await loadSlide(slide, driver);
      if (!buffer) continue;

      const framePath = join(work, `frame-${String(index).padStart(3, '0')}.jpg`);
      await sharp(buffer)
        .resize(width, height, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 92 })
        .toFile(framePath);
      frames.push({ path: framePath, slide });
    }
    if (!frames.length) throw new Error('None of the photos for this reel could be read');

    // --- 2. one clip per photo, with pan/zoom and caption ------------------
    const clips: string[] = [];

    const titlePath = join(work, 'title.mp4');
    await renderCard(
      { width, height, background: brand, title: spec.title, subtitle: spec.subtitle, price: spec.price },
      TITLE_SECONDS, work, titlePath, 'title',
    );
    clips.push(titlePath);

    for (const [index, frame] of frames.entries()) {
      const clipPath = join(work, `clip-${index}.mp4`);
      await renderSlideClip(frame.path, clipPath, {
        width, height, seconds: perSlide,
        caption: frame.slide.caption,
        zoomIn: index % 2 === 0,
      }, work);
      clips.push(clipPath);
    }

    const outroPath = join(work, 'outro.mp4');
    await renderCard(
      { width, height, background: brand, title: spec.cta ?? 'Book a site visit', subtitle: spec.subtitle },
      OUTRO_SECONDS, work, outroPath, 'outro',
    );
    clips.push(outroPath);

    // --- 3. join with crossfades ------------------------------------------
    const joined = join(work, 'joined.mp4');
    await crossfade(clips, joined, [TITLE_SECONDS, ...frames.map(() => perSlide), OUTRO_SECONDS]);

    // --- 4. watermark ------------------------------------------------------
    const watermarked = join(work, 'watermarked.mp4');
    await applyWatermark(joined, watermarked, width, height);

    let final = watermarked;
    if (spec.music && await isReelMusicAvailable()) {
      const withMusic = join(work, 'reel.mp4');
      try {
        await mixMusic(watermarked, withMusic);
        final = withMusic;
      } catch (err) {
        // A corrupt or unsupported optional audio asset must not discard a
        // successfully rendered video. Ship the silent cut and log the issue.
        logger.warn({ err }, 'reel: music mix failed, using the silent cut');
      }
    }

    const key = `renders/reel-${jobId}.mp4`;
    await driver.save(key, createReadStream(final), 'video/mp4');

    const duration = TITLE_SECONDS + frames.length * perSlide + OUTRO_SECONDS
      - FADE * (clips.length - 1);

    return { key, mime: 'video/mp4', durationSeconds: Math.round(duration) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function loadSlide(
  slide: ReelSlide,
  driver: Awaited<ReturnType<typeof getDriver>>,
): Promise<Buffer | null> {
  if (slide.key) {
    const buffer = await driver.read(slide.key);
    if (buffer) return buffer;
  }
  return null;
}

/**
 * One photo, drifting.
 *
 * `zoompan` works per output frame, so the zoom expression is written against
 * `on` (output frame number) and the filter runs at the final frame rate. The
 * `d` parameter is in frames, not seconds — getting that wrong produces a
 * one-frame clip, which is the classic way this filter looks broken.
 */
async function renderSlideClip(
  imagePath: string,
  outputPath: string,
  opts: { width: number; height: number; seconds: number; caption?: string; zoomIn: boolean },
  work: string,
): Promise<void> {
  const fps = 30;
  const frames = Math.round(opts.seconds * fps);
  const maxZoom = 1.12;

  // Alternating direction stops a long reel feeling like one continuous push.
  const zoomExpr = opts.zoomIn
    ? `min(1+(${maxZoom - 1})*on/${frames},${maxZoom})`
    : `max(${maxZoom}-(${maxZoom - 1})*on/${frames},1)`;

  // zoompan renders from a larger intermediate so the zoom does not soften the
  // image; scaling back down afterwards keeps the output crisp.
  const filters = [
    `scale=${opts.width * 2}:${opts.height * 2}`,
    `zoompan=z='${zoomExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${opts.width}x${opts.height}:fps=${fps}`,
    'format=yuv420p',
  ];

  const args = ['-y', '-loop', '1', '-i', imagePath];

  if (opts.caption) {
    // Caption drawn as a PNG rather than with drawtext: drawtext needs a font
    // path that differs on every host, and escaping arbitrary user text into a
    // filtergraph is a quoting minefield. An overlay is boring and always works.
    const captionPath = join(work, `caption-${Math.random().toString(36).slice(2)}.png`);
    await writeFile(captionPath, await renderCaptionPng(opts.width, opts.height, opts.caption));
    args.push('-i', captionPath);
    args.push(
      '-filter_complex', `[0:v]${filters.join(',')}[bg];[bg][1:v]overlay=0:0[out]`,
      '-map', '[out]',
    );
  } else {
    args.push('-vf', filters.join(','));
  }

  args.push(
    '-t', String(opts.seconds),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
    outputPath,
  );

  await runFfmpeg(args);
}

async function renderCaptionPng(width: number, height: number, caption: string): Promise<Buffer> {
  const fontSize = Math.round(width * 0.052);
  const lines = wrapSvgText(caption, Math.floor(width / (fontSize * 0.55)));
  const blockHeight = lines.length * fontSize * 1.25 + width * 0.08;
  const top = height - blockHeight - Math.round(height * 0.1);

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(2,6,23,0)"/>
        <stop offset="100%" stop-color="rgba(2,6,23,0.85)"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${top - width * 0.12}" width="${width}" height="${blockHeight + width * 0.22}" fill="url(#fade)"/>
    ${lines.map((line, i) => `<text x="${Math.round(width * 0.07)}" y="${top + (i + 1) * fontSize * 1.25}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff">${escapeXml(line)}</text>`).join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderCard(
  info: { width: number; height: number; background: string; title: string; subtitle?: string; price?: string },
  seconds: number,
  work: string,
  outputPath: string,
  tag: string,
): Promise<void> {
  const { width: w, height: h } = info;
  const titleSize = Math.round(w * 0.085);
  const titleLines = fitLines(info.title, Math.floor(w / (titleSize * 0.55)), 4);
  const titleStart = h * 0.4;
  const titleStep = titleSize * 1.15;
  const titleLast = titleStart + (titleLines.length - 1) * titleStep;
  const subtitleY = titleLast + titleSize * 1.35;
  const priceY = info.subtitle ? subtitleY + w * 0.15 : titleLast + w * 0.17;

  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="${escapeXml(info.background)}"/>
    <text x="${w * 0.08}" y="${h * 0.2}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(w * 0.032)}" letter-spacing="6" fill="rgba(255,255,255,0.75)">IPROPY</text>
    ${titleLines.map((line, i) => `<text x="${w * 0.08}" y="${titleStart + i * titleStep}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${titleSize}" fill="#ffffff">${escapeXml(line)}</text>`).join('')}
    ${info.subtitle ? `<text x="${w * 0.08}" y="${subtitleY}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(w * 0.036)}" fill="rgba(255,255,255,0.85)">${escapeXml(info.subtitle)}</text>` : ''}
    ${info.price ? `<text x="${w * 0.08}" y="${priceY}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${Math.round(w * 0.07)}" fill="#ffffff">${escapeXml(info.price)}</text>` : ''}
  </svg>`;

  const pngPath = join(work, `${tag}.png`);
  await writeFile(pngPath, await sharp(Buffer.from(svg)).png().toBuffer());

  await runFfmpeg([
    '-y', '-loop', '1', '-i', pngPath,
    '-t', String(seconds), '-r', '30',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
}

/**
 * Chain the clips with `xfade`.
 *
 * xfade takes exactly two inputs, so an N-clip reel is N-1 nested fades. Each
 * offset is "everything before me, minus the fades already consumed" — get that
 * cumulative arithmetic wrong and the back half of the reel plays at once.
 */
async function crossfade(clips: string[], outputPath: string, durations: number[]): Promise<void> {
  if (clips.length === 1) {
    await runFfmpeg(['-y', '-i', clips[0], '-c', 'copy', outputPath]);
    return;
  }

  const args: string[] = ['-y'];
  for (const clip of clips) args.push('-i', clip);

  const steps: string[] = [];
  let previous = '[0:v]';
  let elapsed = durations[0];

  for (let i = 1; i < clips.length; i++) {
    const label = i === clips.length - 1 ? '[out]' : `[x${i}]`;
    const offset = Math.max(0, elapsed - FADE);
    steps.push(`${previous}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}${label}`);
    previous = label;
    elapsed = offset + durations[i];
  }

  args.push(
    '-filter_complex', steps.join(';'),
    '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  );
  await runFfmpeg(args);
}

async function applyWatermark(
  inputPath: string, outputPath: string, width: number, height: number,
): Promise<void> {
  try {
    const wm = await watermarkFor(width, height);
    // A frame too small to carry a readable badge takes the same path as a
    // watermark that failed to render: the cut, unbranded, which is still a
    // reel worth having.
    if (!wm) throw new Error('frame too small for a readable watermark');
    const wmPath = join(tmpdir(), `ipropy-reel-wm-${Date.now()}.png`);
    await writeFile(wmPath, wm.buffer);
    try {
      await runFfmpeg([
        '-y', '-i', inputPath, '-i', wmPath,
        '-filter_complex', `[0:v][1:v]overlay=W-w-${wm.margin}:H-h-${wm.margin}[out]`,
        '-map', '[out]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputPath,
      ]);
    } finally {
      await rm(wmPath, { force: true }).catch(() => undefined);
    }
  } catch (err) {
    // A reel without a watermark is still a reel worth having.
    logger.warn({ err }, 'reel: watermark failed, using the unwatermarked cut');
    await runFfmpeg(['-y', '-i', inputPath, '-c', 'copy', outputPath]);
  }
}

async function mixMusic(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y', '-i', inputPath, '-stream_loop', '-1', '-i', MUSIC_TRACK_PATH,
    '-filter_complex', `[1:a]volume=${MUSIC_VOLUME}[music]`,
    '-map', '0:v', '-map', '[music]',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    outputPath,
  ]);
}

/** Direct execFile for the reasons documented in video.ts. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        // ffmpeg's real diagnosis is always the last few lines of stderr; the
        // Error object alone just says it exited non-zero.
        return reject(new Error(`ffmpeg failed: ${String(stderr).split('\n').slice(-6).join(' ').slice(0, 500)}`));
      }
      resolve();
    });
  });
}

function wrapSvgText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

function fitLines(text: string, maxChars: number, maxLines: number): string[] {
  const wrapped = wrapSvgText(text, maxChars);
  if (wrapped.length <= maxLines) return wrapped;
  const visible = wrapped.slice(0, maxLines);
  const last = visible[maxLines - 1];
  visible[maxLines - 1] = `${last.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
  return visible;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
