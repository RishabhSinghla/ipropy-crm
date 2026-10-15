/*
  Is this request path asking for a file rather than for a screen?

  The single-page app answers every unknown path with its home page, so a deep link
  like /leads/123 works. That is wrong for a file: a request for a script that no
  longer exists (an old build's chunk name) must be "not found", not the home page
  with a 200. Otherwise the browser, and the service worker that caches whatever
  comes back OK, treats a web page as if it were the script, and the screen that
  needed it fails with "Failed to fetch dynamically imported module" until the
  cache is cleared by hand. Found on 15 October 2026.

  A file is anything whose last segment ends in a dot and letters or digits.
*/
export function looksLikeAFile(path: string): boolean {
  const lastSegment = path.split('/').pop() ?? '';
  return /\.[A-Za-z0-9]{1,12}$/.test(lastSegment);
}
