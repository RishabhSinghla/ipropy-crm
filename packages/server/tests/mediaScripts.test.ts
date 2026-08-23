/**
 * The worker's copy of a script is not allowed to be a different script.
 *
 * `media-service/scripts/` holds four programs the owner wrote and asked to be
 * used "as is". They are not imported by anything in this repository, no test
 * runner touches them, and the container is built from whatever happens to be
 * in that folder — which is exactly the shape of a file that drifts for months
 * without anybody noticing.
 *
 * It did. The worker's `professional_photo_finish.py` was an older, shorter
 * program that finished the photo *and* applied the watermark. The pipeline
 * then applied the watermark again in its own step, so every photograph came
 * out with two logos on it. Nothing failed, nothing was logged, and it was only
 * found by looking at a rendered image.
 *
 * These are the cheapest possible guards against that: read the files, assert
 * the things that must be true about them. Milliseconds, no Python, and they
 * fail in CI rather than in somebody's OneDrive.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dirname, '../../../media-service/scripts');
const read = (name: string): string => readFileSync(join(SCRIPTS, name), 'utf8');

describe('the media worker scripts', () => {
  it('all exist where the Dockerfile copies them from', () => {
    for (const name of [
      'professional_photo_finish.py',
      'compress_iphone_media.py',
      'render_ipropy_watermark.py',
      'prepare_photos.sh',
      'make_all_shapes.sh',
      'name_and_describe.py',
      'make_photo_reel.py',
      'edit_walkthrough.py',
      'reelkit.py',
      'crm.py',
    ]) {
      expect(existsSync(join(SCRIPTS, name)), `${name} is missing`).toBe(true);
    }
  });

  /**
   * The regression. Finishing and watermarking are separate steps in the
   * pipeline, and the finish runs first — so a finish script that also
   * watermarks produces two logos and no error.
   */
  it('finishes a photo without watermarking it', () => {
    const finish = read('professional_photo_finish.py');
    expect(finish).not.toMatch(/from\s+render_ipropy_watermark\s+import/);
    expect(finish).not.toMatch(/\badd_watermark\b/);
    expect(finish).not.toMatch(/extract_official_logo/);
  });

  it('watermarks in exactly one place', () => {
    const watermarkers = ['professional_photo_finish.py', 'compress_iphone_media.py', 'prepare_photos.sh']
      .filter((name) => /add_watermark|render_ipropy_watermark/.test(read(name)));
    expect(watermarkers, 'only render_ipropy_watermark.py may apply the logo').toEqual([]);
  });

  /**
   * `sips` is macOS only. Every one of these scripts reached for it as the HEIC
   * fallback, which is fine on the owner's Mac and is nothing at all on the
   * server the pipeline actually runs on — the symptom being an iPhone photo
   * that silently skipped a step.
   */
  it('never depends on sips alone to read a HEIC', () => {
    for (const name of ['professional_photo_finish.py', 'compress_iphone_media.py']) {
      const body = read(name);
      if (!body.includes('sips')) continue;
      expect(body, `${name} falls back to sips with no GraphicsMagick path`).toMatch(/\bgm\b|graphicsmagick/i);
    }
  });

  it('reads subprocess output tolerantly, because a phone writes what it likes', () => {
    // ffprobe and gm echo the file's own metadata. One byte of Latin-1 in a
    // camera's title tag otherwise raises UnicodeDecodeError out of subprocess
    // itself, which reads as the pipeline crashing.
    for (const name of ['reelkit.py', 'compress_iphone_media.py', 'name_and_describe.py']) {
      const body = read(name);
      if (!body.includes('text=True')) continue;
      expect(body, `${name} decodes subprocess output strictly`).toContain('errors="replace"');
    }
  });

  it('keeps the pipeline order out of the worker, where n8n cannot reach it', () => {
    const app = readFileSync(join(SCRIPTS, '../app.py'), 'utf8');
    // The order arrives in the request. The worker owns what each step *is* and
    // has no opinion about which run or in what sequence.
    expect(app).toMatch(/DEFAULT_STEPS/);
    expect(app).toMatch(/body\.get\("steps"\)/);
  });
});
