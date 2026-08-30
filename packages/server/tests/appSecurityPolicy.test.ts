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
import { describe, expect, it, vi } from 'vitest';

async function directivesFor(isProd: boolean): Promise<string> {
  vi.resetModules();
  vi.doMock('../src/config.js', async () => {
    const actual = await vi.importActual<{ config: Record<string, unknown> }>('../src/config.js');
    return { config: { ...actual.config, isProd } };
  });
  const { applyAppSecurityPolicy } = await import('../src/app.js');
  const headers: Record<string, string> = {};
  applyAppSecurityPolicy({ setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; } } as never);
  return headers['content-security-policy'] ?? '';
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
