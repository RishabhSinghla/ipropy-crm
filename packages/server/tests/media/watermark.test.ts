/**
 * Stamping the badge, and knowing when not to.
 *
 * The bug these pin was a job that could never succeed and was retried
 * forever. `watermarkFor` floors the badge at 60px so "IPROPY" stays readable;
 * on an image narrower than that the badge is wider than the thing it is being
 * stamped onto, sharp's composite refuses an overlay larger than its base,
 * `processImage` let that throw, and the media queue tried again — against an
 * image exactly as small on the tenth attempt as on the first.
 *
 * Nothing off a phone hits it. A logo, an icon, a scanned stamp or a signature
 * crop does, and one of those uploaded to a record used to occupy the queue
 * indefinitely.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { watermarkFor } from '../../src/core/media/watermark.js';
import { processImage } from '../../src/core/media/images.js';
import type { StorageDriver } from '../../src/core/storage/index.js';

const solid = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: '#888' } }).jpeg().toBuffer();

/** Collects what was written instead of touching a disk or a bucket. */
function fakeDriver(): StorageDriver & { saved: Map<string, Buffer> } {
  const saved = new Map<string, Buffer>();
  return {
    saved,
    async save(key, data) { saved.set(key, data as Buffer); },
    async read(key) { return saved.get(key) ?? null; },
    async remove(key) { saved.delete(key); },
    async readToTempFile() { return null; },
  };
}

describe('sizing the badge', () => {
  it('scales with the image so it reads the same on any size', async () => {
    const small = await watermarkFor(800, 600);
    const large = await watermarkFor(2400, 1600);
    expect(small!.width).toBe(128);
    expect(large!.width).toBe(384);
    // Same proportion of the frame, so it looks identical once displayed.
    expect(small!.width / 800).toBeCloseTo(large!.width / 2400, 5);
  });

  it('stops shrinking below the point the word is readable', async () => {
    // 16% of 200px would be 32px wide — "IPROPY" in a 32px badge is a smudge.
    expect((await watermarkFor(200, 200))!.width).toBe(60);
  });

  it('gives up rather than returning a badge wider than the image', async () => {
    // The failure itself. Before the fix this returned a 60px badge for a 40px
    // image and the caller threw.
    expect(await watermarkFor(40, 40)).toBeNull();
    expect(await watermarkFor(20, 20)).toBeNull();
    expect(await watermarkFor(1, 1)).toBeNull();
  });

  it('gives up on an image too short to hold it', async () => {
    // A wide, shallow crop — a letterhead strip, a signature. Wide enough for
    // the badge, nowhere near tall enough.
    expect(await watermarkFor(60, 10)).toBeNull();
    expect(await watermarkFor(400, 12)).toBeNull();
  });

  it('leaves room for its own margin', async () => {
    // sharp only refuses an overlay strictly larger than the base, so a badge
    // exactly the width of the image would composite — as a bar across the
    // whole picture, which is not a watermark.
    const wm = await watermarkFor(62, 62);
    expect(wm === null || wm.width + wm.margin <= 62).toBe(true);
  });

  it('always positions inside the frame when it returns one', async () => {
    // What lets images.ts drop its Math.max(0, …) clamps: a returned badge is
    // guaranteed to fit, margin included.
    for (const [w, h] of [[100, 60], [480, 360], [1200, 900], [2400, 1600]] as const) {
      const wm = await watermarkFor(w, h);
      expect(wm).not.toBeNull();
      expect(w - wm!.width - wm!.margin).toBeGreaterThanOrEqual(0);
      expect(h - wm!.height - wm!.margin).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('processing an image', () => {
  it('does not throw on an image too small to watermark', async () => {
    // The regression. This used to reject, and because the media queue retries,
    // the same 40px image was reprocessed forever.
    const driver = fakeDriver();
    const variants = await processImage(driver, 'att-1', 'icons/logo.png', await solid(40, 40));

    expect(variants).not.toBeNull();
    // Still produces every derivative — just unbranded.
    expect(Object.keys(variants!).sort()).toEqual(['large', 'medium', 'thumb']);
    expect(driver.saved.size).toBe(3);
  });

  it('still watermarks an ordinary photo', async () => {
    // The other half: proving the skip is narrow and has not quietly disabled
    // branding everywhere.
    const driver = fakeDriver();
    const variants = await processImage(driver, 'att-2', 'properties/x/IMG_1.jpg', await solid(1600, 1200));

    expect(variants).not.toBeNull();
    const plain = driver.saved.get(variants!.thumb!)!;
    const branded = driver.saved.get(variants!.large!)!;
    // The watermarked derivative carries pixels the unbranded one does not, so
    // a solid-colour source cannot compress to the same thing.
    expect(branded.length).toBeGreaterThan(plain.length);
  });

  it('returns null for something that is not an image at all', async () => {
    // Decode failure is a deliberate no-op — serve the original, make no
    // derivatives — and must stay distinct from a job worth retrying.
    const driver = fakeDriver();
    expect(await processImage(driver, 'att-3', 'x.jpg', Buffer.from('not an image'))).toBeNull();
    expect(driver.saved.size).toBe(0);
  });
});
