/**
 * A published photo must not be able to run a script.
 *
 * The stored mime type is whatever the uploading client declared in its
 * multipart part. It is never derived and never sniffed. So anyone who can
 * attach a file to a property that later gets published could serve
 * `image/svg+xml` from the CRM's own origin, and an SVG opened as a top-level
 * document runs the scripts inside it. The session token lives in localStorage
 * and the API deliberately runs without a CSP of its own, so that is not a
 * defaced picture, it is the whole session.
 *
 * `applyFileSecurityHeaders` had existed and been applied to the signed-in file
 * route since it was written. The public catalogue route and both share-link
 * routes never called it — the one set of routes reachable without logging in.
 *
 * These test the helper's guarantees directly rather than through a live
 * server, because what has to hold is a property of the headers: whatever mime
 * type comes out of the database, the response cannot execute.
 */
import { describe, expect, it } from 'vitest';
import { applyFileSecurityHeaders, dispositionFor } from '../src/core/media/serving.js';

function capture(mimeType: string, fileName = 'photo', wantsDownload = false): Record<string, string> {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; } };
  applyFileSecurityHeaders(res as never, mimeType, fileName, wantsDownload);
  return headers;
}

describe('headers on a file anyone can fetch', () => {
  it.each([
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml; charset=utf-8',
  ])('sandboxes %s so it cannot reach the session', (mime) => {
    const csp = capture(mime)['content-security-policy'] ?? '';

    // `sandbox` with no allow-list is an opaque origin with scripts disabled.
    // It is the one directive that holds even when the type is a lie.
    expect(csp).toContain('sandbox');
    expect(csp).toContain("default-src 'none'");
    // No same-origin escape hatch, which would give the scripts the session back.
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-scripts');
  });

  it('stops a browser second-guessing the declared type', () => {
    expect(capture('image/png')['x-content-type-options']).toBe('nosniff');
  });

  it('downloads markup rather than rendering it', () => {
    // Belt as well as braces: the sandbox covers a rendered document, and this
    // stops it being rendered in the first place.
    expect(dispositionFor('text/html', false)).toBe('attachment');
    expect(dispositionFor('application/xhtml+xml', false)).toBe('attachment');
  });

  it('still shows a real photograph in place', () => {
    // The guard is worthless if it breaks the website it protects.
    expect(dispositionFor('image/jpeg', false)).toBe('inline');
    expect(dispositionFor('image/webp', false)).toBe('inline');
    expect(dispositionFor('application/pdf', false)).toBe('inline');
  });

  it('keeps an SVG embeddable, because <img> never runs one', () => {
    // Deliberate: an SVG is a legitimate floor plan. It renders as an image and
    // the sandbox above is what covers somebody opening it directly.
    expect(dispositionFor('image/svg+xml', false)).toBe('inline');
  });

  it('puts the filename somewhere a header cannot be split', () => {
    const cd = capture('image/png', 'a"; evil=1\r\nX-Injected: yes')['content-disposition'] ?? '';
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    expect(cd.startsWith('inline; filename="')).toBe(true);
  });
});

describe('every public byte-serving route calls the helper', () => {
  it('leaves no raw Content-Type on a file response in public.ts', async () => {
    /*
      The regression this pins is not a logic error, it is an omission: a fifth
      route gets added later, sets its own Content-Type, and is unprotected in
      exactly the way the first four were. So this reads the file and asserts
      the shape rather than any one behaviour.
    */
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/api/routes/public.ts', import.meta.url),
      'utf8',
    );

    // Count the places that hand back stored bytes, and the places that harden.
    const sends = source.match(/res\.send\(|res\.sendFile\(/g) ?? [];
    const hardened = source.match(/applyFileSecurityHeaders\(/g) ?? [];

    expect(hardened.length, 'every file response must be hardened').toBeGreaterThanOrEqual(4);
    expect(sends.length, 'a new file response was added without hardening it')
      .toBeLessThanOrEqual(hardened.length + 1); // +1: the companion APK, a fixed local file.

    /*
      No route may set a Content-Type it got from somewhere else. A hard-coded
      literal is fine — the companion APK is a fixed file on disk with a type
      this repo chose, and it downloads. What is never fine is echoing back a
      type that arrived with an upload, which is precisely the bypass.
    */
    const echoedType = (source.match(/res\.setHeader\(\s*'Content-Type',[^)\n]*/g) ?? [])
      .map((line) => line.slice(line.indexOf(',') + 1).trim())
      // A quoted literal is a type this repo chose. Anything else came from a row.
      .filter((argument) => !argument.startsWith("'"));

    expect(echoedType, 'a stored mime type must go through applyFileSecurityHeaders').toHaveLength(0);
  });
});
