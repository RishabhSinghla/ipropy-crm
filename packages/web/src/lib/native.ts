/**
 * The seam between the React app and the native shell.
 *
 * The same bundle runs in three places: a desktop browser, a phone browser, and
 * inside the Android/iOS app. Nothing outside this file is allowed to care
 * which. Every export here answers sensibly on the web — usually by doing
 * nothing — so a browser build behaves exactly as it did before the app
 * existed, and no page needs an `if (app)` branch.
 *
 * `@capacitor/core` ships a web shim, so importing it costs the browser a few
 * hundred bytes and no behaviour. The plugins are imported lazily, inside the
 * functions that use them, because a browser must never pay to download the
 * camera bridge it will never call.
 */
import { Capacitor } from '@capacitor/core';

export const isNative: boolean = Capacitor.isNativePlatform();
export const platform: 'ios' | 'android' | 'web' =
  Capacitor.getPlatform() as 'ios' | 'android' | 'web';
export const isAndroid = platform === 'android';
export const isIOS = platform === 'ios';

// ---------------------------------------------------------------------------
// Where the server is
// ---------------------------------------------------------------------------

/*
 * In a browser the app and the API share an origin, so every path stays
 * relative and there is no CORS, no cookie question and nothing to configure.
 *
 * In the app there is no shared origin: the HTML is served from inside the
 * installed bundle (`https://localhost` on Android, `capacitor://localhost` on
 * iOS) and the API is somewhere else entirely. So every request has to be made
 * absolute, and the server has to be told to accept those two origins — see
 * `nativeOrigins` in server/src/app.ts.
 *
 * The default is production, because that is where the team's data is and a
 * rep installing the app should never have to type a URL. The override exists
 * for exactly two people: whoever is testing a build against a laptop, and
 * whoever is standing up a second tenant.
 */
const DEFAULT_API_BASE = 'https://crm.ipropy.com';
const OVERRIDE_KEY = 'ipropy.apiBase';

/*
 * Resolved once at boot and then read synchronously, because `request()` is
 * synchronous at its start and an await there would turn every API call in the
 * app into a race against the first one. `boot()` fills this in before React
 * mounts; until then the compiled-in default stands, which is correct for
 * every real install and wrong only for an override that has not loaded yet.
 */
let apiBaseValue = isNative
  ? ((import.meta.env.VITE_API_BASE as string | undefined) ?? DEFAULT_API_BASE)
  : '';

/** '' in a browser (same origin), an absolute origin in the app. */
export function apiBase(): string {
  return apiBaseValue;
}

/** Make a server path absolute. Leaves absolute URLs and non-API paths alone. */
export function serverUrl(path: string): string {
  if (!apiBaseValue) return path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return apiBaseValue + (path.startsWith('/') ? path : `/${path}`);
}

/** Point the app at a different server. Persists across launches. */
export async function setApiBase(url: string): Promise<void> {
  const clean = url.trim().replace(/\/+$/, '');
  const { Preferences } = await import('@capacitor/preferences');
  if (clean) await Preferences.set({ key: OVERRIDE_KEY, value: clean });
  else await Preferences.remove({ key: OVERRIDE_KEY });
  apiBaseValue = clean || DEFAULT_API_BASE;
}

// ---------------------------------------------------------------------------
// The refresh token
// ---------------------------------------------------------------------------

/*
 * On the web the refresh token lives in an httpOnly cookie, out of reach of
 * any script on the page. That protection does not survive the move to an app:
 * the cookie would be a third-party one (bundle origin asking crm.ipropy.com),
 * and both platforms' webviews are increasingly willing to drop those without
 * telling anyone. A team silently signed out every hour is not a trade worth
 * making.
 *
 * So the app uses the body path the server still accepts, and keeps the token
 * in native storage instead. The threat the cookie defends against — a script
 * injected into the page reading the token — does not exist in the same way
 * here: the app loads its HTML and JavaScript from inside the installed
 * bundle, not from a server, so there is no request an attacker can poison and
 * no third-party origin to inject from.
 */
const REFRESH_KEY = 'ipropy.refresh';

export async function getStoredRefresh(): Promise<string | null> {
  if (!isNative) return null;
  const { Preferences } = await import('@capacitor/preferences');
  const { value } = await Preferences.get({ key: REFRESH_KEY });
  return value ?? null;
}

export async function setStoredRefresh(token: string | null): Promise<void> {
  if (!isNative) return;
  const { Preferences } = await import('@capacitor/preferences');
  if (token) await Preferences.set({ key: REFRESH_KEY, value: token });
  else await Preferences.remove({ key: REFRESH_KEY });
}

/*
 * A synchronous mirror of the stored token.
 *
 * `request()` cannot await storage before deciding whether it has a session,
 * so `boot()` reads the token once into here and every write keeps it in step.
 * Storage stays the source of truth across launches; this is the copy the
 * refresh path is allowed to read without blocking.
 */
let refreshCache: string | null = null;
export function cachedRefresh(): string | null { return refreshCache; }
export function rememberRefresh(token: string | null): void {
  refreshCache = token;
  void setStoredRefresh(token);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Everything that must be true before the first render or the first request.
 * Resolves immediately on the web.
 */
export async function boot(): Promise<void> {
  if (!isNative) return;

  /*
    A hook for the handful of rules that are about being an installed app
    rather than about being on a small screen — which is a different question,
    and the reason this is not a media query. A phone browser wants the
    long-press menu and the text selection; the app wants neither on its own
    chrome, because there they read as the page underneath showing through.
  */
  document.documentElement.classList.add('native', platform);

  const { Preferences } = await import('@capacitor/preferences');
  const [override, refresh] = await Promise.all([
    Preferences.get({ key: OVERRIDE_KEY }),
    Preferences.get({ key: REFRESH_KEY }),
  ]);
  if (override.value) apiBaseValue = override.value;
  refreshCache = refresh.value ?? null;

  // The splash screen hides in main.tsx once React has actually painted, not
  // here — hiding it at the end of boot shows a white rectangle for however
  // long the first render takes.
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // The app draws its own header under the clock and battery, so the bar has
    // to stop reserving space for itself. Android only; on iOS the safe-area
    // insets in styles.css do this job and overlay is the default.
    if (isAndroid) await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Light });
  } catch { /* a webview with no status bar to style is not an error */ }
}
