import type { CSSProperties } from 'react';

/**
 * Accessible colour derivation for admin-chosen hues.
 *
 * Picklist options, modules and score ramps each carry one hex colour, picked
 * by an admin for recognition rather than legibility. Every badge in the app
 * used to paint that hex as *text* on a 9% tint *of itself*, which lands
 * between 2:1 and 4:1 — well under the 4.5:1 WCAG AA requires, and these are
 * 11px labels. An axe sweep of leads/properties/detail found ~55 nodes failing
 * on this one pattern alone, in both themes.
 *
 * Two things are fixed here:
 *
 * 1. The hue is kept but its *lightness* is walked until the pair genuinely
 *    passes, so a status chip still reads as "green" while being readable.
 * 2. The background is made opaque. A translucent tint composites against
 *    whatever happens to sit behind it — card, zebra stripe, hover state — so
 *    its true contrast changed as the user moved the mouse, and no fixed
 *    foreground could be correct for all of them.
 *
 * Both themes are emitted at once as CSS custom properties (see `badgeVars`)
 * rather than resolved in JS against the current theme. A table can hold
 * several hundred badges; making each one subscribe to the theme store would
 * add several hundred subscriptions and a re-render of the whole grid on
 * toggle, to compute something CSS can select for free.
 */

type RGB = readonly [number, number, number];

/** WCAG AA for normal-size text. Badges are 11px, so this is the bar that applies. */
export const AA_NORMAL = 4.5;

/** WCAG AA for large text — 18pt+, or 14pt bold. Metric values are 24px semibold. */
export const AA_LARGE = 3;

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: RGB): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1:1 (identical) to 21:1 (black on white). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Snap to whole channels. Every colour here ends up as a hex string, so this
 * is the value the browser will actually paint — and contrast has to be
 * measured on it. Checking the un-rounded float instead lets a pair pass at
 * 4.502 and ship at 4.497.
 */
function quantise(rgb: RGB): RGB {
  return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])];
}

/** `fg` laid over `bg` at `alpha`, flattened to an opaque colour. */
function flatten(fg: RGB, bg: RGB, alpha: number): RGB {
  return quantise([0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as unknown as RGB);
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toChannel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [toChannel(h + 1 / 3) * 255, toChannel(h) * 255, toChannel(h - 1 / 3) * 255];
}

/**
 * The nearest variant of `hue` that clears `target` against `bg`, found by
 * moving lightness only — hue and saturation are preserved so the result still
 * reads as the colour the admin picked.
 *
 * `darken` says which way to walk: toward black on light backgrounds, toward
 * white on dark ones. Walking the wrong way would eventually pass too, but by
 * crossing the background's own lightness, which looks like a different colour.
 */
export function readableOn(hue: RGB, bg: RGB, darken: boolean, target = AA_NORMAL): RGB {
  if (contrastRatio(hue, bg) >= target) return hue;
  const [h, s, l] = rgbToHsl(hue);
  // 1% steps: fine enough that the result is visually the same colour, and
  // bounded so this can never spin.
  for (let step = 1; step <= 100; step++) {
    const next = darken ? l - step / 100 : l + step / 100;
    if (next < 0 || next > 1) break;
    const candidate = quantise(hslToRgb(h, s, next));
    if (contrastRatio(candidate, bg) >= target) return candidate;
  }
  // Fully saturated hues against a mid-luminance background can be unreachable
  // at every lightness; black/white always clears it.
  return darken ? [0, 0, 0] : [255, 255, 255];
}

/**
 * The opaque surfaces a tinted chip actually sits on: `.card` and table rows
 * are white in light mode and slate-900 in dark. Body (slate-50 / slate-950)
 * is close enough in luminance that a chip readable on one is readable on the
 * other, which the unit tests assert against both.
 */
const SURFACE = {
  light: [255, 255, 255] as RGB,
  dark: [15, 23, 42] as RGB,
} as const;

/** How much of the hue shows through in the chip's background, per theme. */
const TINT = { light: 0.12, dark: 0.24 } as const;

export interface BadgeColors {
  bg: string;
  fg: string;
  border: string;
}

/** Readable background/text/border for `color` in one theme. */
export function badgeColors(color: string, theme: 'light' | 'dark'): BadgeColors | null {
  const hue = hexToRgb(color);
  if (!hue) return null;
  const light = theme === 'light';
  const bg = flatten(hue, SURFACE[theme], TINT[theme]);
  return {
    bg: rgbToHex(bg),
    fg: rgbToHex(readableOn(hue, bg, light)),
    // The border only has to be *visible*, not readable, so it stays close to
    // the hue: pushing it to AA would draw a hard outline around every chip.
    border: rgbToHex(flatten(hue, bg, light ? 0.35 : 0.45)),
  };
}

/**
 * Both themes' values as custom properties, consumed by `.badge-tinted` in
 * styles.css. Resolving the theme in CSS rather than JS keeps badges free of
 * store subscriptions — see the note at the top of this file.
 */
export function badgeVars(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  const cached = cache.get(color);
  if (cached !== undefined) return cached ?? undefined;

  const light = badgeColors(color, 'light');
  const dark = badgeColors(color, 'dark');
  const vars = light && dark
    ? ({
        '--badge-bg': light.bg,
        '--badge-fg': light.fg,
        '--badge-bd': light.border,
        '--badge-bg-dark': dark.bg,
        '--badge-fg-dark': dark.fg,
        '--badge-bd-dark': dark.border,
        // So `.text-tinted` on a child reads correctly against the chip's own
        // background rather than the page surface.
        '--tinted-fg': light.fg,
        '--tinted-fg-dark': dark.fg,
      } as CSSProperties)
    : null;

  // Colours come from a small admin-managed palette, so this stays tiny in
  // practice; the cap is only here so a pathological dataset cannot grow it
  // without bound.
  if (cache.size < 500) cache.set(color, vars);
  return vars ?? undefined;
}

const cache = new Map<string, CSSProperties | null>();

/**
 * A hue used as plain text directly on the page surface — a metric value, a
 * funnel conversion rate — rather than inside a tinted chip.
 *
 * Same idea as `badgeVars`, but measured against the card background, and at
 * the 3:1 large-text bar when the type is big enough to qualify. A dashboard
 * metric in the admin's brand green was 2.27:1 at 24px before this.
 */
export function tintedTextVars(
  color: string | null | undefined,
  opts: { large?: boolean } = {},
): CSSProperties | undefined {
  if (!color) return undefined;
  const key = `${color}|${opts.large ? 'lg' : 'sm'}`;
  const hit = textCache.get(key);
  if (hit !== undefined) return hit ?? undefined;

  const hue = hexToRgb(color);
  const target = opts.large ? AA_LARGE : AA_NORMAL;
  const vars = hue
    ? ({
        '--tinted-fg': rgbToHex(readableOn(hue, SURFACE.light, true, target)),
        '--tinted-fg-dark': rgbToHex(readableOn(hue, SURFACE.dark, false, target)),
      } as CSSProperties)
    : null;

  if (textCache.size < 500) textCache.set(key, vars);
  return vars ?? undefined;
}

const textCache = new Map<string, CSSProperties | null>();
