/**
 * The manifest's shortcuts have to point at screens that exist.
 *
 * These are what a long-press on the Home Screen icon offers, and there is no
 * error when one is wrong: the CRM opens, the route matches nothing, and the
 * person gets an empty page from a menu the product put in front of them.
 *
 * `site_visits` was one of them for months — a module removed by migrations
 * `030`, `031` and `048`. Nobody saw it because nobody had installed the app
 * on a phone.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
) as { display: string; icons: { src: string }[]; shortcuts?: { name: string; url: string }[] };

/*
  The two modules this CRM has, plus the fixed pages. Named here rather than
  read from the database on purpose: a manifest is a static file built into the
  bundle, so it cannot follow an admin adding a module, and the only safe
  entries are the ones that cannot go away.
*/
const REAL_ROUTES = ['/leads', '/properties', '/whatsapp', '/dashboard', '/settings', '/reports', '/calls'];

describe('the Home Screen install', () => {
  it('opens full screen rather than in a browser tab', () => {
    expect(manifest.display).toBe('standalone');
  });

  it('offers only shortcuts that resolve', () => {
    for (const shortcut of manifest.shortcuts ?? []) {
      expect(REAL_ROUTES, `"${shortcut.name}" points at ${shortcut.url}, which is not a screen`)
        .toContain(shortcut.url);
    }
  });

  it('carries the icon sizes both platforms ask for', () => {
    const sizes = manifest.icons.map((icon) => icon.src);
    expect(sizes).toContain('/icons/icon-192.png');
    expect(sizes).toContain('/icons/icon-512.png');
  });
});
