/**
 * Making an uploaded file safe to hand back to a browser.
 *
 * The stored mime type is whatever the uploading client declared in its
 * multipart part — it is not derived, sniffed or validated anywhere. Echoing it
 * back with `Content-Disposition: inline` therefore lets anyone who can attach
 * a file to a record publish an HTML page on the CRM's own origin: upload
 * `notes.html` as `text/html`, send a colleague the link, read their session
 * token out of localStorage when they open it. An SVG does the same thing, and
 * neither needs the filename to look suspicious — the type is declared
 * separately from the extension.
 *
 * The API deliberately runs without a CSP (`helmet({ contentSecurityPolicy:
 * false })` in app.ts) because it serves files inline for the previewer, so
 * there was nothing behind that first line of defence.
 *
 * Two independent guards here, because either one alone has a gap:
 *
 *  * **The disposition allow-list** decides what may render in the page at all.
 *    Only the handful of types the document viewer actually embeds stay
 *    `inline`; everything else downloads, and a downloaded file executes
 *    nothing. This is what stops `text/html`.
 *  * **The response CSP** assumes the allow-list will one day be widened by
 *    somebody who has not read this comment. `sandbox` puts the response in an
 *    opaque origin with scripts disabled, so even an SVG or an HTML file
 *    reached directly cannot touch the session.
 */
import type { Response } from 'express';

/**
 * Types the document viewer genuinely embeds — `<img>`, `<video>`, `<audio>`
 * and the PDF `<iframe>`. Text, CSV and markdown are deliberately absent: the
 * viewer fetches those and renders them itself, and `fetch` ignores
 * Content-Disposition, so they lose nothing by downloading on direct access.
 */
function isEmbeddable(mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime === 'application/pdf') return true;
  // SVG is an image to `<img>` and a script host to a top-level navigation.
  // It stays embeddable — `<img>` never runs its scripts — and the sandbox CSP
  // below is what covers the navigation case.
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
}

/**
 * `inline` only for what a browser should render in place, and only when the
 * caller asked for a preview rather than a download.
 */
export function dispositionFor(mimeType: string, wantsDownload: boolean): 'inline' | 'attachment' {
  if (wantsDownload) return 'attachment';
  return isEmbeddable(mimeType) ? 'inline' : 'attachment';
}

/**
 * Headers every file response carries, whatever the driver behind it.
 *
 * `sandbox` is the load-bearing one: it costs nothing for an image and removes
 * script execution from everything else. `nosniff` stops a browser deciding a
 * .txt is really HTML. `default-src 'none'` means a file that does render
 * cannot fetch, frame or beacon anything back out.
 */
export function applyFileSecurityHeaders(res: Response, mimeType: string, fileName: string, wantsDownload: boolean): void {
  const disposition = dispositionFor(mimeType, wantsDownload);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(fileName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; object-src 'none'; frame-ancestors 'self'; sandbox",
  );
}
