import { describe, expect, it, vi } from 'vitest';
import { applyFileSecurityHeaders, dispositionFor } from '../../src/core/media/serving.js';

/**
 * The stored mime type is whatever the uploading client declared — nothing
 * derives or validates it. Serving that back inline let any user who can attach
 * a file publish an HTML page on the CRM's own origin and read a colleague's
 * session token out of localStorage. These pin both halves of the fix.
 */
describe('dispositionFor', () => {
  it('downloads the types that can execute', () => {
    for (const mime of [
      'text/html',
      'text/html; charset=utf-8',
      'application/xhtml+xml',
      'application/javascript',
      'text/xml',
      'application/xml',
    ]) {
      expect(dispositionFor(mime, false), mime).toBe('attachment');
    }
  });

  it('still embeds what the document viewer actually previews', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'audio/mpeg']) {
      expect(dispositionFor(mime, false), mime).toBe('inline');
    }
  });

  it('downloads text and csv, which the viewer fetches rather than embeds', () => {
    // fetch() ignores Content-Disposition, so the preview is unaffected and a
    // direct hit on the URL saves the file instead of rendering it.
    for (const mime of ['text/plain', 'text/csv', 'text/markdown', 'application/json']) {
      expect(dispositionFor(mime, false), mime).toBe('attachment');
    }
  });

  it('honours an explicit download request even for an image', () => {
    expect(dispositionFor('image/png', true)).toBe('attachment');
  });

  it('is not fooled by casing or a charset parameter', () => {
    expect(dispositionFor('TEXT/HTML', false)).toBe('attachment');
    expect(dispositionFor('IMAGE/PNG; charset=binary', false)).toBe('inline');
  });

  it('downloads a type it has never heard of', () => {
    expect(dispositionFor('application/x-msdownload', false)).toBe('attachment');
    expect(dispositionFor('', false)).toBe('attachment');
  });
});

describe('applyFileSecurityHeaders', () => {
  function fakeRes() {
    const headers: Record<string, string> = {};
    return { headers, setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }) };
  }

  it('sandboxes every response, so even an inline SVG cannot run scripts', () => {
    // Verified in a real browser: Chrome refuses with "Blocked script execution
    // … the document's frame is sandboxed". SVG stays inline because <img>
    // never runs its scripts; this covers someone opening the URL directly.
    const res = fakeRes();
    applyFileSecurityHeaders(res as never, 'image/svg+xml', 'logo.svg', false);
    expect(res.headers['Content-Security-Policy']).toContain('sandbox');
    expect(res.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(res.headers['Content-Disposition']).toContain('inline');
  });

  it('stops a browser sniffing a type of its own', () => {
    const res = fakeRes();
    applyFileSecurityHeaders(res as never, 'text/plain', 'notes.txt', false);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('escapes the filename rather than letting it break the header', () => {
    const res = fakeRes();
    applyFileSecurityHeaders(res as never, 'image/png', 'a"; drop=1; x="b.png', false);
    expect(res.headers['Content-Disposition']).not.toContain('drop=1;');
  });
});
