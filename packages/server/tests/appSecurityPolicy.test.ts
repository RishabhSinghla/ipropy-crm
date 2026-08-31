/**
 * The policy on the app's own HTML.
 *
 * There wasn't one. `app.ts` set `contentSecurityPolicy: false` with a comment
 * saying the web app enforced it, and nothing did — the live HTML carried no
 * policy header at all. So the one defence that would have contained the public
 * file hole had none of it in place.
 *
 * These assert the directives that make it worth having, and the two
 * relaxations that are deliberate, because the temptation when something breaks
 * is to add `unsafe-inline` to `script-src` and move on. That would leave the
 * policy present and pointless.
 *
 * Verified separately against the real built app: served from `packages/web/dist`
 * under exactly this policy, signed in, and walked the dashboard, leads,
 * properties, reports, admin settings and inbox. Zero
 * `securitypolicyviolation` events.
 */
import { describe, expect, it } from 'vitest';
import { securityPolicy } from '../src/app.js';

/*
  Called directly rather than through a mocked config module. That mock made
  this file flaky once `app.ts` began importing the error reporter, which reads
  config as well — two test files re-mocking the same module while sharing a
  graph is a race, and a test that fails one run in ten is one people learn to
  ignore.
*/
async function directivesFor(isProd: boolean): Promise<string> {
  return securityPolicy(isProd);
}

describe('the policy on the app HTML', () => {
  it('does not allow inline script, which is the entire point', async () => {
    /*
      The build emits no inline script — index.html is one external module plus
      preloads — so the strict form costs nothing here. If a future change adds
      an inline script and somebody reaches for 'unsafe-inline' to fix it, this
      fails, and it should: an injected <script> and an injected onclick both
      stop running the moment that word appears.
    */
    const csp = await directivesFor(true);

    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows inline style, deliberately', async () => {
    // React writes inline styles for transitions, positioning and the charts,
    // and there is no nonce path through those. Inline CSS cannot read a token.
    expect(await directivesFor(true)).toContain("style-src 'self' 'unsafe-inline'");
  });

  it.each([
    ["default-src 'self'", 'nothing loads from anywhere else by default'],
    ["object-src 'none'", 'no plugins, the classic injection escape'],
    ["base-uri 'self'", 'an injected <base> cannot re-point every relative URL'],
    ["frame-ancestors 'none'", 'nothing frames a CRM'],
    ["form-action 'self'", 'a form cannot post credentials elsewhere'],
  ])('sets %s', async (directive) => {
    expect(await directivesFor(true)).toContain(directive);
  });

  it('lets the websocket through, or realtime silently stops', async () => {
    // Socket.IO is same-origin but ws:, which connect-src 'self' alone refuses.
    const csp = await directivesFor(true);
    expect(csp).toMatch(/connect-src [^;]*'self'/);
    expect(csp).toMatch(/connect-src [^;]*wss:/);
  });

  it('lets crash reports out, or error reporting is installed and mute', async () => {
    /*
      This policy blocked the browser's reports the day it shipped — every
      cross-origin request, which silently included the POST carrying a crash.
      The feature would have looked installed and sent nothing, and nothing
      anywhere would have said so.
    */
    const csp = await directivesFor(true);
    expect(csp).toMatch(/connect-src [^;]*ingest\.sentry\.io/);
    // Only ingest hosts. This is not an invitation to widen it further.
    expect(csp).not.toMatch(/connect-src [^;]*\*\s/);
  });

  it('allows the data: favicon and blob: previews', async () => {
    // index.html carries an inline SVG favicon as a data URL, and the uploader
    // previews a chosen file from a blob before it has been sent anywhere.
    const csp = await directivesFor(true);
    expect(csp).toMatch(/img-src [^;]*data:/);
    expect(csp).toMatch(/img-src [^;]*blob:/);
  });

  it('upgrades insecure requests in production only', async () => {
    // Locally the app is plain http, and the directive would break every asset.
    expect(await directivesFor(true)).toContain('upgrade-insecure-requests');
    expect(await directivesFor(false)).not.toContain('upgrade-insecure-requests');
  });
});

describe('where the policy actually lands', () => {
  it('goes on the HTML file express.static serves, not only the catch-all', async () => {
    /*
      The bug this pins, which shipped once. `express.static` answers `/` with
      `index.html` itself, before the `app.get('*')` below it ever runs. Setting
      the header only in the catch-all put it on a route that never fires for the
      one request that matters, so the deployed site came back with no policy at
      all — indistinguishable from a failed deploy.

      Read from the source, because the alternative is booting an Express app
      with a built frontend on disk, and a test that needs `npm run build` first
      is a test that gets skipped.
    */
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

    const staticBlock = source.slice(source.indexOf('express.static('), source.indexOf("app.get('*'"));
    expect(staticBlock, 'the static handler must set the policy on .html itself')
      .toContain('applyAppSecurityPolicy');
    expect(staticBlock, 'and only on html, so a service worker does not inherit it')
      .toContain(".endsWith('.html')");
  });

  it('is not applied as blanket middleware', async () => {
    // A CSP on a .js response is ignored for the script, but a service worker
    // takes its policy from its own response headers, and default-src 'self'
    // there is a different and much easier thing to get wrong.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/app.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/app\.use\(\s*\(req, res, next\) => \{\s*applyAppSecurityPolicy/);
  });
});
