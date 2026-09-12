/**
 * The origins the API answers to.
 *
 * This file exists because of how the failure looks. Drop either localhost
 * entry as a tidy-up — they read exactly like a development leftover — and the
 * Android and iOS apps stop at the login screen with a CORS error, on
 * production only, with every test green and the website unaffected. Nothing
 * in the app's own code changed, so that is not where anybody would look.
 *
 * A Capacitor app serves its HTML from inside the installed bundle, and the
 * origin the webview stamps on every request is `https://localhost` on Android
 * and `capacitor://localhost` on iOS. Neither is a host reachable over a
 * network — you cannot point a browser at them and you cannot claim them — so
 * allowing them widens nothing.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

async function origins(appUrl: string): Promise<string[]> {
  vi.resetModules();
  process.env.APP_URL = appUrl;
  const { allowedOrigins } = await import('../src/config.js');
  return allowedOrigins();
}

afterEach(() => { delete process.env.APP_URL; });

describe('allowedOrigins', () => {
  it('includes the website', async () => {
    expect(await origins('https://crm.ipropy.com')).toContain('https://crm.ipropy.com');
  });

  it('accepts several, comma separated, as the deploy documentation says', async () => {
    const list = await origins('https://crm.ipropy.com, https://ipropy-crm.onrender.com');
    expect(list).toContain('https://crm.ipropy.com');
    expect(list).toContain('https://ipropy-crm.onrender.com');
  });

  it('includes the Android app, which is not a leftover', async () => {
    expect(await origins('https://crm.ipropy.com')).toContain('https://localhost');
  });

  it('includes the iPhone app, which is not a leftover either', async () => {
    expect(await origins('https://crm.ipropy.com')).toContain('capacitor://localhost');
  });

  it('holds both app origins even when no website is configured', async () => {
    const list = await origins('');
    expect(list).toEqual(expect.arrayContaining(['https://localhost', 'capacitor://localhost']));
  });

  it('never contains a blank, which some CORS middlewares read as "any"', async () => {
    const list = await origins('https://crm.ipropy.com, , https://ipropy.com');
    expect(list).not.toContain('');
  });
});
