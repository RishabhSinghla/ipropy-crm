/**
 * The design model behind the social-post studio, and the renderer that draws it.
 *
 * A design is plain data — a size plus an ordered list of layers — which is
 * what makes the rest work: the same function draws the on-screen preview and
 * the exported PNG, so what you see is what downloads, and a saved design is a
 * small JSON blob rather than a rasterised image nobody can edit again.
 *
 * Deliberately not a general design tool. This exists to turn a listing into a
 * post for Instagram or WhatsApp in under a minute, so the layer types are the
 * handful that job needs.
 */

export interface Size { width: number; height: number }

export const CANVAS_PRESETS: { key: string; label: string; note: string; size: Size }[] = [
  { key: 'ig_square', label: 'Instagram post', note: '1:1', size: { width: 1080, height: 1080 } },
  { key: 'ig_portrait', label: 'Instagram portrait', note: '4:5 — takes the most feed space', size: { width: 1080, height: 1350 } },
  { key: 'ig_story', label: 'Story / Reel cover', note: '9:16', size: { width: 1080, height: 1920 } },
  { key: 'fb_link', label: 'Facebook / link preview', note: '1.91:1', size: { width: 1200, height: 630 } },
  { key: 'wa_status', label: 'WhatsApp status', note: '9:16', size: { width: 1080, height: 1920 } },
];

export type Layer =
  | { id: string; type: 'rect'; x: number; y: number; w: number; h: number; fill: string; opacity?: number; radius?: number }
  /** A vertical fade, used to keep text legible over a photo. */
  | { id: string; type: 'gradient'; x: number; y: number; w: number; h: number; from: string; to: string }
  | { id: string; type: 'image'; x: number; y: number; w: number; h: number; src: string; fit?: 'cover' | 'contain' }
  | {
      id: string; type: 'text'; x: number; y: number; w: number;
      text: string; size: number; color: string; weight?: number;
      align?: 'left' | 'center' | 'right'; lineHeight?: number; uppercase?: boolean; letterSpacing?: number;
    };

export interface Design {
  size: Size;
  background: string;
  layers: Layer[];
}

export function layerLabel(layer: Layer): string {
  if (layer.type === 'text') return layer.text.slice(0, 28) || 'Text';
  if (layer.type === 'image') return 'Photo';
  if (layer.type === 'gradient') return 'Fade';
  return 'Shape';
}

/**
 * Draw a design onto a canvas.
 *
 * Async because images have to be decoded first: drawing before they load
 * yields a blank rectangle, and that failure is invisible until someone posts
 * the result. Images that fail entirely are skipped rather than throwing, so
 * one dead photo cannot take the whole export down.
 */
export async function renderDesign(canvas: HTMLCanvasElement, design: Design): Promise<void> {
  canvas.width = design.size.width;
  canvas.height = design.size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = design.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const layer of design.layers) {
    switch (layer.type) {
      case 'rect': {
        ctx.save();
        ctx.globalAlpha = layer.opacity ?? 1;
        ctx.fillStyle = layer.fill;
        roundedRect(ctx, layer.x, layer.y, layer.w, layer.h, layer.radius ?? 0);
        ctx.fill();
        ctx.restore();
        break;
      }
      case 'gradient': {
        const grad = ctx.createLinearGradient(0, layer.y, 0, layer.y + layer.h);
        grad.addColorStop(0, layer.from);
        grad.addColorStop(1, layer.to);
        ctx.fillStyle = grad;
        ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
        break;
      }
      case 'image': {
        const img = await loadImage(layer.src);
        if (!img) break;
        drawFitted(ctx, img, layer.x, layer.y, layer.w, layer.h, layer.fit ?? 'cover');
        break;
      }
      case 'text':
        drawText(ctx, layer);
        break;
    }
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

const imageCache = new Map<string, HTMLImageElement | null>();

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (imageCache.has(src)) return imageCache.get(src) ?? null;
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    // Same-origin (/api/files/…) so the canvas is never tainted and toBlob
    // keeps working; crossOrigin is set anyway for any external photo.
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  imageCache.set(src, img);
  return img;
}

/** `cover` crops to fill — the right default for a photo behind text. */
function drawFitted(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  x: number, y: number, w: number, h: number, fit: 'cover' | 'contain',
): void {
  const scale = fit === 'cover'
    ? Math.max(w / img.width, h / img.height)
    : Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  ctx.save();
  roundedRect(ctx, x, y, w, h, 0);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Canvas has no text wrapping, so this measures and breaks by hand. Without it
 * a long project name runs straight off the edge of the image — the single
 * most common way a generated post looks broken.
 */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawText(ctx: CanvasRenderingContext2D, layer: Extract<Layer, { type: 'text' }>): void {
  const content = layer.uppercase ? layer.text.toUpperCase() : layer.text;
  ctx.save();
  ctx.fillStyle = layer.color;
  ctx.font = `${layer.weight ?? 600} ${layer.size}px "Inter", system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.letterSpacing = `${layer.letterSpacing ?? 0}px`;

  const lines = wrapText(ctx, content, layer.w);
  const lineHeight = layer.size * (layer.lineHeight ?? 1.2);

  lines.forEach((line, i) => {
    const width = ctx.measureText(line).width;
    const x = layer.align === 'center'
      ? layer.x + (layer.w - width) / 2
      : layer.align === 'right'
        ? layer.x + layer.w - width
        : layer.x;
    ctx.fillText(line, x, layer.y + i * lineHeight);
  });

  ctx.restore();
}

/** Total drawn height of a text layer — used for hit-testing and selection. */
export function textHeight(layer: Extract<Layer, { type: 'text' }>, ctx: CanvasRenderingContext2D): number {
  ctx.font = `${layer.weight ?? 600} ${layer.size}px "Inter", system-ui, -apple-system, sans-serif`;
  const lines = wrapText(ctx, layer.uppercase ? layer.text.toUpperCase() : layer.text, layer.w);
  return lines.length * layer.size * (layer.lineHeight ?? 1.2);
}
