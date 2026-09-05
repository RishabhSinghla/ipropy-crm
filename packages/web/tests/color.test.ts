import { describe, expect, it } from 'vitest';
import {
  AA_LARGE,
  AA_NORMAL,
  badgeColors,
  badgeVars,
  contrastRatio,
  hexToRgb,
  readableOn,
  rgbToHex,
  solidColors,
  avatarBackground,
  tintedTextVars,
} from '../src/lib/color';

/**
 * The contrast guarantee, asserted here rather than only in the axe e2e sweep.
 *
 * The maths is pure, so it can be checked exhaustively in milliseconds against
 * every colour the product actually ships — where the browser sweep only sees
 * whichever chips happen to be on screen in the seeded data, and only catches a
 * regression after someone has already rendered it.
 */

/** Every hex in db/seed — i.e. the real palette a fresh install ships with. */
const SEEDED_PALETTE = [
  '#0ea5e9', '#10b981', '#14b8a6', '#22c55e', '#3b82f6', '#6366f1',
  '#64748b', '#84cc16', '#8b5cf6', '#94a3b8', '#a855f7', '#b45309',
  '#dc2626', '#ec4899', '#ef4444', '#f59e0b', '#f97316',
];

/** The opaque surfaces a chip can land on, per theme. */
const SURFACES = {
  light: { white: '#ffffff', body: '#f8fafc', muted: '#f1f5f9' },
  dark: { card: '#0f172a', body: '#020617', raised: '#1e293b' },
};

function ratio(a: string, b: string): number {
  return contrastRatio(hexToRgb(a)!, hexToRgb(b)!);
}

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // slate-500 on white — the canonical "just passes AA" muted pairing.
    expect(ratio('#64748b', '#ffffff')).toBeCloseTo(4.76, 1);
    // slate-400 on white, which is what the app used and which fails.
    expect(ratio('#94a3b8', '#ffffff')).toBeCloseTo(2.56, 1);
  });

  it('is symmetric', () => {
    expect(ratio('#f97316', '#ffffff')).toBeCloseTo(ratio('#ffffff', '#f97316'), 10);
  });
});

describe('hex parsing', () => {
  it('accepts 3- and 6-digit forms, with or without the hash', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#F97316')).toEqual([249, 115, 22]);
  });

  it('rejects anything else rather than producing a silent NaN colour', () => {
    for (const bad of ['', 'red', '#12', '#1234567', 'rgb(0,0,0)', '#gggggg']) {
      expect(hexToRgb(bad)).toBeNull();
    }
  });

  it('round-trips', () => {
    for (const hex of SEEDED_PALETTE) expect(rgbToHex(hexToRgb(hex)!)).toBe(hex);
  });
});

describe('readableOn', () => {
  it('leaves a colour alone when it already passes', () => {
    const hue = hexToRgb('#b45309')!; // already 4.9:1 on white
    expect(readableOn(hue, hexToRgb('#ffffff')!, true)).toEqual(hue);
  });

  it('preserves hue while moving lightness', () => {
    // Orange must stay recognisably orange: red channel highest, blue lowest.
    const fixed = readableOn(hexToRgb('#f97316')!, hexToRgb('#fef1e8')!, true);
    expect(fixed[0]).toBeGreaterThan(fixed[1]);
    expect(fixed[1]).toBeGreaterThan(fixed[2]);
  });

  it('terminates and passes even when the colour equals its background', () => {
    // The worst input there is: 1:1 to start with, and mid-grey so there is
    // little headroom either way. It must return a passing colour, not spin.
    const out = readableOn(hexToRgb('#808080')!, hexToRgb('#808080')!, true);
    expect(contrastRatio(out, hexToRgb('#808080')!)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('never overshoots past the background into the opposite tone', () => {
    // Walking the wrong way would also eventually pass, but by crossing the
    // background's luminance — a "darkened" colour that came out lighter.
    const bg = hexToRgb('#fef1e8')!;
    const out = readableOn(hexToRgb('#f97316')!, bg, true);
    expect(out.reduce((a, b) => a + b)).toBeLessThan(bg.reduce((a, b) => a + b));
  });
});

describe('solidColors', () => {
  /**
   * The chip the team actually reads, since the list moved to Vtiger's
   * full-strength fill. The tinted variant's guarantee does not carry over:
   * the fill is now the admin's hue at full saturation and the text is black
   * or white, so this is a different pair and needs its own assertion.
   */
  it('clears AA for every seeded colour, in both themes', () => {
    for (const color of SEEDED_PALETTE) {
      for (const theme of ['light', 'dark'] as const) {
        const c = solidColors(color, theme)!;
        expect(c, `${color} / ${theme}`).not.toBeNull();
        const r = ratio(c.fg, c.bg);
        expect(r, `${color} / ${theme}: ${c.fg} on ${c.bg} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  it('only ever puts black or white on the fill', () => {
    // The point of the solid chip is that the hue is the fill. A third
    // "readable-ish" foreground would drift the design back toward the tinted
    // variant one colour at a time.
    for (const color of SEEDED_PALETTE) {
      for (const theme of ['light', 'dark'] as const) {
        expect(['#ffffff', '#0f172a']).toContain(solidColors(color, theme)!.fg);
      }
    }
  });

  it('keeps the hue the admin picked', () => {
    // Lightness may move to earn the contrast; hue may not. A red status that
    // arrives on screen orange is a bug report, not an accessibility win.
    // Compared as the ranking of the R/G/B channels rather than through an HSL
    // round-trip: that ordering is what makes a colour read as "the red one",
    // and it survives the lightness walk exactly when the hue does.
    const rank = (rgb: readonly number[]): string => [0, 1, 2].sort((a, b) => rgb[b] - rgb[a]).join('');
    for (const color of SEEDED_PALETTE) {
      for (const theme of ['light', 'dark'] as const) {
        const fill = hexToRgb(solidColors(color, theme)!.bg)!;
        expect(rank(fill), `${color} / ${theme}`).toBe(rank(hexToRgb(color)!));
      }
    }
  });

  it('never returns a fill that vanishes into the page', () => {
    for (const color of SEEDED_PALETTE) {
      for (const [theme, surfaces] of Object.entries(SURFACES) as ['light' | 'dark', Record<string, string>][]) {
        const c = solidColors(color, theme)!;
        for (const [name, surface] of Object.entries(surfaces)) {
          expect(ratio(c.bg, surface), `${color} / ${theme} / ${name}`).toBeGreaterThan(1.05);
        }
      }
    }
  });

  it('rejects a bad hex rather than painting a NaN chip', () => {
    expect(solidColors('not-a-colour', 'light')).toBeNull();
  });
});

describe('badgeColors', () => {
  it('clears AA for every seeded colour, in both themes', () => {
    for (const color of SEEDED_PALETTE) {
      for (const theme of ['light', 'dark'] as const) {
        const c = badgeColors(color, theme)!;
        expect(c, `${color} / ${theme}`).not.toBeNull();
        const r = ratio(c.fg, c.bg);
        expect(r, `${color} / ${theme}: ${c.fg} on ${c.bg} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  it('stays readable on every surface the chip can actually land on', () => {
    // The background is opaque, so the surface behind it cannot change the
    // text contrast — but the chip's own background must still be
    // distinguishable from the surface, or the chip disappears into the page.
    for (const color of SEEDED_PALETTE) {
      for (const [theme, surfaces] of Object.entries(SURFACES) as ['light' | 'dark', Record<string, string>][]) {
        const c = badgeColors(color, theme)!;
        for (const [name, surface] of Object.entries(surfaces)) {
          if (c.bg === surface) continue;
          const r = ratio(c.border, surface);
          expect(r, `${color} / ${theme} / ${name}: border ${c.border} on ${surface}`).toBeGreaterThan(1.05);
        }
      }
    }
  });

  it('adjusts away from the surface, never toward it', () => {
    // A colour is only moved when it has to be, so the assertion is
    // directional rather than strict: light-mode text may only get darker,
    // dark-mode text may only get lighter.
    for (const color of SEEDED_PALETTE) {
      const light = badgeColors(color, 'light')!;
      const dark = badgeColors(color, 'dark')!;
      expect(ratio(light.fg, '#ffffff'), `${color} light`).toBeGreaterThanOrEqual(ratio(color, '#ffffff') - 1e-9);
      expect(ratio(dark.fg, '#000000'), `${color} dark`).toBeGreaterThanOrEqual(ratio(color, '#000000') - 1e-9);
    }
  });

  it('actually moves the colours that need it', () => {
    // Guards the assertion above from passing vacuously if nothing is adjusted.
    const moved = SEEDED_PALETTE.filter((c) => badgeColors(c, 'light')!.fg.toLowerCase() !== c.toLowerCase());
    expect(moved.length).toBeGreaterThan(SEEDED_PALETTE.length / 2);
  });

  it('returns null for an unparseable colour instead of emitting broken CSS', () => {
    expect(badgeColors('not-a-colour', 'light')).toBeNull();
  });

  it('is deterministic', () => {
    for (const color of SEEDED_PALETTE) {
      expect(badgeColors(color, 'light')).toEqual(badgeColors(color, 'light'));
    }
  });
});

describe('badgeVars', () => {
  it('emits both themes so CSS can switch without a re-render', () => {
    const vars = badgeVars('#f97316') as Record<string, string>;
    expect(Object.keys(vars).sort()).toEqual([
      '--badge-bd', '--badge-bd-dark', '--badge-bg', '--badge-bg-dark', '--badge-fg', '--badge-fg-dark',
      // Both variants come off one call. A chip and the module tile beside it
      // share a hue, and computing them separately doubled the cache.
      '--badge-solid-bg', '--badge-solid-bg-dark', '--badge-solid-fg', '--badge-solid-fg-dark',
      // So .text-tinted on a child of the chip resolves against the chip.
      '--tinted-fg', '--tinted-fg-dark',
    ]);
  });

  it('is undefined for empty input, so callers fall back to the neutral chip', () => {
    expect(badgeVars(null)).toBeUndefined();
    expect(badgeVars(undefined)).toBeUndefined();
    expect(badgeVars('')).toBeUndefined();
    expect(badgeVars('#zzzzzz')).toBeUndefined();
  });

  it('returns a stable reference for repeat colours', () => {
    // Table rows re-render constantly; a fresh object each time would defeat
    // memoisation on every badge in the grid.
    expect(badgeVars('#3b82f6')).toBe(badgeVars('#3b82f6'));
  });
});

describe('tintedTextVars', () => {
  const surfaces = { light: '#ffffff', dark: '#0f172a' };

  it('clears AA for normal-size text on the page surface', () => {
    for (const color of SEEDED_PALETTE) {
      const v = tintedTextVars(color) as Record<string, string>;
      expect(ratio(v['--tinted-fg'], surfaces.light), `${color} light`).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(ratio(v['--tinted-fg-dark'], surfaces.dark), `${color} dark`).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('clears the 3:1 large-text bar when the type qualifies', () => {
    // Dashboard metric values are 24px semibold, so AA asks for 3:1 rather
    // than 4.5:1 — the admin's brand colour survives closer to as chosen.
    for (const color of SEEDED_PALETTE) {
      const v = tintedTextVars(color, { large: true }) as Record<string, string>;
      expect(ratio(v['--tinted-fg'], surfaces.light), `${color} light`).toBeGreaterThanOrEqual(AA_LARGE);
      expect(ratio(v['--tinted-fg-dark'], surfaces.dark), `${color} dark`).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('keeps large text closer to the source colour than small text', () => {
    // The looser bar should mean less correction, not the same correction.
    const small = tintedTextVars('#22c55e') as Record<string, string>;
    const large = tintedTextVars('#22c55e', { large: true }) as Record<string, string>;
    expect(ratio(large['--tinted-fg'], surfaces.light)).toBeLessThan(ratio(small['--tinted-fg'], surfaces.light));
  });

  it('caches per colour *and* per size, not per colour alone', () => {
    expect(tintedTextVars('#0ea5e9')).not.toEqual(tintedTextVars('#0ea5e9', { large: true }));
  });

  it('is undefined for empty or unparseable input', () => {
    expect(tintedTextVars(null)).toBeUndefined();
    expect(tintedTextVars('#nope')).toBeUndefined();
  });
});

describe('the muted text tokens in styles.css', () => {
  // These are the values --text-muted / --text-positive / --text-negative
  // resolve to. They live in CSS, so nothing else can catch a regression here.
  const TOKENS = {
    light: { muted: '#5b6b80', positive: '#047857', negative: '#c81e1e' },
    dark: { muted: '#94a3b8', positive: '#34d399', negative: '#f87171' },
  };
  const SURFACE_SET = {
    light: ['#ffffff', '#f8fafc', '#f1f5f9'],
    dark: ['#0f172a', '#020617', '#1e293b'],
  };

  it('clear AA on every surface of their own theme', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [name, hex] of Object.entries(TOKENS[theme])) {
        for (const surface of SURFACE_SET[theme]) {
          const r = ratio(hex, surface);
          expect(r, `${theme}/${name} ${hex} on ${surface} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
        }
      }
    }
  });

  it('improve on the slate steps they replaced', () => {
    expect(ratio(TOKENS.light.muted, '#ffffff')).toBeGreaterThan(ratio('#94a3b8', '#ffffff'));
    expect(ratio(TOKENS.dark.muted, '#0f172a')).toBeGreaterThan(ratio('#64748b', '#0f172a'));
  });
});

describe('avatarBackground', () => {
  it('is readable with white initials for every hue the hash can produce', () => {
    // The old `hsl(h, 55%, 45%)` passed for blues and failed for greens and
    // yellows, so whether the app was accessible depended on who was on the
    // screen. Sweeping many names covers the whole wheel rather than the few
    // hues the seed data happens to hit.
    const white = hexToRgb('#ffffff')!;
    const failures: string[] = [];
    for (let i = 0; i < 500; i++) {
      const bg = avatarBackground(`Person Number ${i}`);
      const r = contrastRatio(white, hexToRgb(bg)!);
      if (r < AA_NORMAL) failures.push(`${bg} = ${r.toFixed(2)}:1`);
    }
    expect(failures.slice(0, 5).join(', ')).toBe('');
  });

  it('is stable for the same name, so a person keeps their colour', () => {
    expect(avatarBackground('Aisha Khan')).toBe(avatarBackground('Aisha Khan'));
    expect(avatarBackground('Aisha Khan')).not.toBe(avatarBackground('Rohit Sharma'));
  });

  it('still spreads names across distinct colours', () => {
    // Darkening every hue to the same near-black would pass contrast and make
    // avatars useless as a visual identifier.
    const shades = new Set(Array.from({ length: 60 }, (_, i) => avatarBackground(`Name ${i}`)));
    expect(shades.size).toBeGreaterThan(20);
  });

  it('handles an empty name without producing an invalid colour', () => {
    expect(avatarBackground('')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
