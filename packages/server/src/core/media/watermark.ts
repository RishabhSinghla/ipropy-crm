/**
 * A single, in-process-cached "IPROPY" watermark badge, rasterised from SVG
 * at whatever pixel size a given derivative needs. Cheap after the first hit
 * per size — there are only two sizes in practice (medium/large derivatives).
 */
import sharp from 'sharp';

const cache = new Map<number, Promise<Buffer>>();

function svgFor(width: number, height: number): string {
  const fontSize = Math.round(height * 0.4);
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" fill="black" fill-opacity="0.28"/>
    <text x="50%" y="53%" text-anchor="middle" dominant-baseline="middle"
      font-family="Helvetica, Arial, sans-serif" font-weight="600" letter-spacing="2"
      font-size="${fontSize}" fill="white" fill-opacity="0.92">IPROPY</text>
  </svg>`;
}

export interface Watermark {
  buffer: Buffer;
  width: number;
  height: number;
  margin: number;
}

/** Sized proportionally (~16% of image width) so it reads the same on a thumbnail-sized crop as on a hero. */
export async function watermarkFor(imageWidth: number): Promise<Watermark> {
  const width = Math.max(60, Math.round(imageWidth * 0.16));
  const height = Math.round(width * 0.34);
  if (!cache.has(width)) {
    cache.set(width, sharp(Buffer.from(svgFor(width, height))).png().toBuffer());
  }
  const buffer = await cache.get(width)!;
  return { buffer, width, height, margin: Math.round(imageWidth * 0.025) };
}
