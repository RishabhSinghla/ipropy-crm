import { describe, expect, it } from 'vitest';
import { looksLikeAFile } from '../src/utils/looksLikeAFile.js';

describe('a path that asks for a file, not a screen', () => {
  it('knows the app files and assets', () => {
    for (const path of ['/assets/Layout-DRTju-f-.js', '/assets/index-Bi-t6XaH.css', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/favicon.ico']) {
      expect(looksLikeAFile(path)).toBe(true);
    }
  });

  it('leaves screens and deep links to the app', () => {
    for (const path of ['/', '/leads', '/leads/9f1c2c1e-0000-4000-8000-000000000000', '/associates', '/admin/fields', '/market']) {
      expect(looksLikeAFile(path)).toBe(false);
    }
  });

  it('is not fooled by a dot earlier in the path', () => {
    expect(looksLikeAFile('/v1.2/leads')).toBe(false);
  });
});
