/**
 * Photo tools that run in the browser, with no API key and no upload.
 *
 * These are the floor the studio never falls below. AI editing is better at
 * everything here, but it needs a Gemini key and a round trip; these work
 * offline, instantly, on a phone, forever. When both are available the AI is
 * offered first — but "no key configured" must never mean "no photo editing".
 *
 * Everything operates on an ImageData buffer and returns a new one, so the
 * operations compose and nothing mutates the caller's canvas underneath them.
 */

export interface Adjustments {
  /** -100…100 */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 0…100 — a mild unsharp mask, the single most useful fix for phone photos. */
  sharpen: number;
}

export const NEUTRAL: Adjustments = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 };

export function applyAdjustments(source: ImageData, adjust: Adjustments): ImageData {
  const out = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const data = out.data;

  // Standard contrast curve; the 259/255 constant keeps mid-grey fixed so
  // raising contrast does not also brighten the whole image.
  const contrast = (adjust.contrast / 100) * 255;
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const brightness = (adjust.brightness / 100) * 255;
  const saturation = 1 + adjust.saturation / 100;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    r += brightness; g += brightness; b += brightness;
    r = contrastFactor * (r - 128) + 128;
    g = contrastFactor * (g - 128) + 128;
    b = contrastFactor * (b - 128) + 128;

    if (saturation !== 1) {
      // Rec. 601 luma — perceptual weights, so desaturating a red wall does not
      // turn it a different lightness than the grey next to it.
      const grey = 0.299 * r + 0.587 * g + 0.114 * b;
      r = grey + (r - grey) * saturation;
      g = grey + (g - grey) * saturation;
      b = grey + (b - grey) * saturation;
    }

    data[i] = clamp(r);
    data[i + 1] = clamp(g);
    data[i + 2] = clamp(b);
  }

  return adjust.sharpen > 0 ? sharpen(out, adjust.sharpen / 100) : out;
}

/** 3×3 unsharp kernel, blended by `amount` so the slider is continuous. */
function sharpen(source: ImageData, amount: number): ImageData {
  const { width, height, data } = source;
  const out = new ImageData(new Uint8ClampedArray(data), width, height);
  const target = out.data;
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        let k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            sum += data[((y + ky) * width + (x + kx)) * 4 + channel] * kernel[k++];
          }
        }
        const original = data[index + channel];
        target[index + channel] = clamp(original + (sum - original) * amount);
      }
    }
  }
  return out;
}

/**
 * Remove a flat background.
 *
 * Deliberately *not* a segmentation model. A general "remove the background"
 * for arbitrary photos needs a neural net and several megabytes of weights, and
 * on a property desk the job that actually comes up is a logo, a floor plan or
 * a brochure scan on a white or near-white sheet — which is a flood fill.
 *
 * Flood filling from the corners rather than thresholding every pixel is what
 * keeps a white kitchen wall inside the photo opaque: only background connected
 * to an edge is removed, so an interior white region survives. That distinction
 * is the whole difference between this being useful and being a wrecking ball.
 */
export function removeFlatBackground(source: ImageData, tolerance = 24): ImageData {
  const { width, height } = source;
  const out = new ImageData(new Uint8ClampedArray(source.data), width, height);
  const data = out.data;

  const seeds = sampleCorners(data, width, height);
  if (!seeds) return out;

  const visited = new Uint8Array(width * height);
  // An explicit stack, not recursion: a 12-megapixel photo would blow the call
  // stack several times over.
  const stack: number[] = [0, width - 1, (height - 1) * width, height * width - 1];

  while (stack.length) {
    const pixel = stack.pop();
    if (pixel === undefined || pixel < 0 || pixel >= width * height) continue;
    if (visited[pixel]) continue;
    visited[pixel] = 1;

    const index = pixel * 4;
    if (!withinTolerance(data, index, seeds, tolerance)) continue;

    data[index + 3] = 0;

    const x = pixel % width;
    if (x > 0) stack.push(pixel - 1);
    if (x < width - 1) stack.push(pixel + 1);
    stack.push(pixel - width, pixel + width);
  }

  return featherEdges(out);
}

/**
 * The average of the four corners, but only if they agree.
 *
 * Disagreeing corners mean the photo has no flat background, and running the
 * fill anyway would eat whatever happens to touch one edge. Returning null
 * turns the operation into a no-op instead, which is the right failure.
 */
function sampleCorners(data: Uint8ClampedArray, width: number, height: number): [number, number, number] | null {
  const corners = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    (height * width - 1) * 4,
  ].map((i) => [data[i], data[i + 1], data[i + 2]] as [number, number, number]);

  const average: [number, number, number] = [
    corners.reduce((sum, c) => sum + c[0], 0) / 4,
    corners.reduce((sum, c) => sum + c[1], 0) / 4,
    corners.reduce((sum, c) => sum + c[2], 0) / 4,
  ];

  const spread = Math.max(...corners.map((c) => distance(c, average)));
  return spread > 60 ? null : average;
}

function withinTolerance(
  data: Uint8ClampedArray, index: number, seed: [number, number, number], tolerance: number,
): boolean {
  return distance([data[index], data[index + 1], data[index + 2]], seed) <= tolerance;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Soften the cut edge.
 *
 * A hard alpha boundary is what makes a cut-out look pasted on; averaging the
 * alpha of each edge pixel's neighbours costs one pass and removes most of it.
 */
function featherEdges(image: ImageData): ImageData {
  const { width, height, data } = image;
  const alpha = new Uint8ClampedArray(width * height);
  for (let p = 0; p < width * height; p++) alpha[p] = data[p * 4 + 3];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if (alpha[p] === 0) continue;

      let sum = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) sum += alpha[(y + ky) * width + (x + kx)];
      }
      const average = sum / 9;
      // Only soften pixels that actually sit on a boundary; leaving the
      // interior alone keeps the subject fully opaque.
      if (average < 255) data[p * 4 + 3] = average;
    }
  }
  return image;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export async function loadImageData(
  src: string,
  maxEdge = 2400,
): Promise<{ data: ImageData; width: number; height: number } | null> {
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const element = new Image();
    element.crossOrigin = 'anonymous';
    element.onload = () => resolve(element);
    element.onerror = () => resolve(null);
    element.src = src;
  });
  if (!image) return null;

  const canvas = document.createElement('canvas');
  // A 12MP phone photo is almost 50MB as ImageData and every slider creates a
  // fresh copy. Keep enough pixels for a full-resolution social post while
  // avoiding browser tab crashes on ordinary sales-team handsets.
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height), width: canvas.width, height: canvas.height };
}

export function hasTransparency(image: ImageData): boolean {
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] < 255) return true;
  }
  return false;
}

export function imageDataToDataUrl(image: ImageData, mime = 'image/png'): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL(mime);
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}
