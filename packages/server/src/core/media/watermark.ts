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

/**
 * Below this the word "IPROPY" is not readable, so the badge stops shrinking.
 *
 * That floor is also what makes `fits` necessary: on an image narrower than
 * 60px the badge is wider than the thing it is being stamped onto, and sharp's
 * composite rejects an overlay larger than its base outright.
 */
const MIN_WIDTH = 60;

/**
 * Sized proportionally (~16% of image width) so it reads the same on a
 * thumbnail-sized crop as on a hero.
 *
 * Returns null when the badge cannot fit — which is not an error and must not
 * be treated as one. This was a real bug: `processImage` let the composite
 * throw, `processAttachment` let that propagate, and the media queue retried
 * the job forever, because a 40px image is exactly as small on the tenth
 * attempt as on the first. A photo from a phone never hits it; a logo, an
 * icon, a scanned stamp or a signature crop does.
 *
 * A watermark nobody can read on an image nobody can see is worth nothing, so
 * skipping it costs nothing either.
 */
export async function watermarkFor(imageWidth: number, imageHeight: number): Promise<Watermark | null> {
  const width = Math.max(MIN_WIDTH, Math.round(imageWidth * 0.16));
  const height = Math.round(width * 0.34);
  const margin = Math.round(imageWidth * 0.025);

  // Margin included on purpose. sharp only refuses an overlay strictly larger
  // than the base, so a badge exactly the size of the image would technically
  // composite — as a bar covering the whole picture, which is not a watermark.
  if (width + margin > imageWidth || height + margin > imageHeight) return null;

  if (!cache.has(width)) {
    cache.set(width, sharp(Buffer.from(svgFor(width, height))).png().toBuffer());
  }
  const buffer = await cache.get(width)!;
  return { buffer, width, height, margin };
}
