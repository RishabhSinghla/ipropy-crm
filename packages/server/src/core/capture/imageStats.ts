/** Conservative, arithmetic-only checks for obviously unusable photographs. */
import sharp from 'sharp';

const ANALYSIS_WIDTH = 512;

export interface ImageStats {
  phash: string;
  sharpness: number;
  brightness: number;
  width: number;
  height: number;
}

// Intentionally forgiving. The user asked for basic culling, so uncertain
// frames survive and only obvious pocket shots, severe blur and near-identical
// duplicates are hidden from the recommended gallery.
export const BLURRY_BELOW = 15;
export const DARK_BELOW = 18;
export const BLOWN_ABOVE = 247;
export const DUPLICATE_WITHIN = 3;

export async function differenceHash(input: Buffer): Promise<string> {
  const { data } = await sharp(input, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = '';
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const left = data[row * 9 + col]!;
      const right = data[row * 9 + col + 1]!;
      bits += left > right ? '1' : '0';
    }
  }

  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let diff = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

export function isDuplicate(a: string, b: string, within = DUPLICATE_WITHIN): boolean {
  return hammingDistance(a, b) <= within;
}

export async function measure(input: Buffer): Promise<Omit<ImageStats, 'phash'>> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize({ width: ANALYSIS_WIDTH, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i]!;
  const brightness = data.length ? sum / data.length : 0;

  let laplacianSum = 0;
  let laplacianSquares = 0;
  let count = 0;
  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const i = y * info.width + x;
      const value = 4 * data[i]!
        - data[i - 1]! - data[i + 1]!
        - data[i - info.width]! - data[i + info.width]!;
      laplacianSum += value;
      laplacianSquares += value * value;
      count += 1;
    }
  }

  const mean = count ? laplacianSum / count : 0;
  const sharpness = count ? laplacianSquares / count - mean * mean : 0;
  return {
    sharpness: Math.round(sharpness * 100) / 100,
    brightness: Math.round(brightness * 100) / 100,
    width: info.width,
    height: info.height,
  };
}

export async function analyse(input: Buffer): Promise<ImageStats> {
  const [phash, rest] = await Promise.all([differenceHash(input), measure(input)]);
  return { phash, ...rest };
}

export type RejectReason = 'blurry' | 'dark' | 'blown' | 'duplicate';

export function ownFault(stats: Pick<ImageStats, 'sharpness' | 'brightness'>): RejectReason | null {
  if (stats.brightness < DARK_BELOW) return 'dark';
  if (stats.brightness > BLOWN_ABOVE) return 'blown';
  if (stats.sharpness < BLURRY_BELOW) return 'blurry';
  return null;
}

export interface Candidate {
  id: string;
  phash: string;
  sharpness: number;
  brightness: number;
}

export interface Verdict {
  id: string;
  keep: boolean;
  reason: RejectReason | null;
  duplicateOf: string | null;
}

/** Keep the sharpest member of each very tight duplicate cluster. */
export function cull(candidates: Candidate[]): Verdict[] {
  const verdicts = new Map<string, Verdict>();
  const representatives: Candidate[] = [];

  for (const candidate of candidates) {
    const twin = representatives.find((kept) => isDuplicate(kept.phash, candidate.phash));
    if (twin) {
      const [winner, loser] = candidate.sharpness > twin.sharpness
        ? [candidate, twin]
        : [twin, candidate];
      verdicts.set(loser.id, { id: loser.id, keep: false, reason: 'duplicate', duplicateOf: winner.id });
      const winnerFault = ownFault(winner);
      verdicts.set(winner.id, {
        id: winner.id, keep: !winnerFault, reason: winnerFault, duplicateOf: null,
      });
      if (winner.id === candidate.id) representatives.splice(representatives.indexOf(twin), 1, candidate);
      continue;
    }

    const fault = ownFault(candidate);
    verdicts.set(candidate.id, { id: candidate.id, keep: !fault, reason: fault, duplicateOf: null });
    representatives.push(candidate);
  }

  return candidates.map((candidate) => verdicts.get(candidate.id)!);
}
