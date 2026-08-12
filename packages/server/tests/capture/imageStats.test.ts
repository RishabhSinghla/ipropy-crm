import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  BLURRY_BELOW, DARK_BELOW, analyse, cull, differenceHash, hammingDistance,
  isDuplicate, measure, ownFault,
} from '../../src/core/capture/imageStats.js';

function room(seed = 0): Promise<Buffer> {
  const svg = `<svg width="900" height="675" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="675" fill="#8a7f6d"/>
    <rect x="${40 + seed}" y="60" width="380" height="420" fill="#f2efe6"/>
    <rect x="${60 + seed}" y="80" width="340" height="380" fill="#cfd8e3"/>
    <rect x="500" y="${120 + seed}" width="330" height="260" fill="#3d3a34"/>
    <rect x="0" y="560" width="900" height="115" fill="#6b6053"/>
    <circle cx="${700 + seed}" cy="480" r="70" fill="#d99b4e"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

describe('basic photo quality checks', () => {
  it('separates severe blur while keeping an ordinary room', async () => {
    const normal = await measure(await room());
    const blurred = await measure(await sharp(await room()).blur(14).jpeg().toBuffer());
    expect(normal.sharpness).toBeGreaterThan(BLURRY_BELOW);
    expect(blurred.sharpness).toBeLessThan(BLURRY_BELOW);
    expect(ownFault(normal)).toBeNull();
  });

  it('flags only an obviously dark pocket shot', async () => {
    const dark = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#080809' } }).jpeg().toBuffer();
    const stats = await measure(dark);
    expect(stats.brightness).toBeLessThan(DARK_BELOW);
    expect(ownFault(stats)).toBe('dark');
  });

  it('recognises a recompressed copy and not a different scene', async () => {
    const original = await room();
    const recompressed = await sharp(original).resize({ width: 640 }).jpeg({ quality: 55 }).toBuffer();
    expect(hammingDistance(await differenceHash(original), await differenceHash(recompressed))).toBeLessThanOrEqual(3);

    const other = await sharp({ create: { width: 900, height: 675, channels: 3, background: '#145aa0' } })
      .composite([{ input: Buffer.from('<svg width="900" height="675"><circle cx="200" cy="200" r="150" fill="#fff"/></svg>') }])
      .jpeg().toBuffer();
    expect(isDuplicate(await differenceHash(original), await differenceHash(other))).toBe(false);
  });

  it('keeps the sharpest duplicate without deleting any candidate', () => {
    const verdicts = cull([
      { id: 'soft', phash: 'ffffffffffffffff', sharpness: 100, brightness: 130 },
      { id: 'sharp', phash: 'ffffffffffffffff', sharpness: 400, brightness: 130 },
      { id: 'different', phash: '0000000000000000', sharpness: 300, brightness: 130 },
    ]);
    expect(verdicts).toHaveLength(3);
    expect(verdicts.find((item) => item.id === 'sharp')?.keep).toBe(true);
    expect(verdicts.find((item) => item.id === 'soft')).toMatchObject({ keep: false, reason: 'duplicate', duplicateOf: 'sharp' });
    expect(verdicts.find((item) => item.id === 'different')?.keep).toBe(true);
  });

  it('returns a complete analysis record', async () => {
    expect(await analyse(await room())).toMatchObject({ phash: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });
});
