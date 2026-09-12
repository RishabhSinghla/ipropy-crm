/**
 * A badge colour the palette cannot read renders nothing at all.
 *
 * `Badge` hands its colour to `badgeVars`, which runs it through `hexToRgb` —
 * a `#rgb`/`#rrggbb` parser. Anything else returns null, the CSS custom
 * properties are never set, and `.badge-solid` is left asking for
 * `var(--badge-solid-bg)` that does not exist: transparent fill, transparent
 * border, inherited text. The chip does not look wrong, it looks absent.
 *
 * That is how the "Revoked" chip on the paired-phones list was written as
 * `color="red"` and shipped as plain grey text — on the one screen where
 * production has three revoked handsets to show.
 *
 * A source check rather than a render test because the mistake is made in the
 * source: it is always legible, so nothing downstream ever complains.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new URL('../../web/src', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('every literal badge colour', () => {
  it('is a hex the palette can parse', () => {
    const offenders: string[] = [];

    for (const file of sources(WEB)) {
      const text = readFileSync(file, 'utf8');
      // Literal colours only. An expression (`color={x}`) carries a value from
      // the database, where an admin picks the colour with a colour picker.
      for (const [, value] of text.matchAll(/<Badge[^>]*?\scolor="([^"]+)"/g)) {
        if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
          offenders.push(`${file.replace(WEB, 'web/src')}: color="${value}"`);
        }
      }
    }

    expect(offenders, 'these render as an invisible chip').toEqual([]);
  });
});
