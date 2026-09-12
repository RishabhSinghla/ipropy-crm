import { create } from 'zustand';
import type { AuthUser } from '@ipropy/shared';
import { ApiError, api, tokenStore, type ModuleSummary } from './api';
import { forgetAll } from './offlineCache';
import { cachedRefresh, isNative, rememberRefresh } from './native';

interface AppState {
  user: AuthUser | null;
  modules: ModuleSummary[];
  loading: boolean;
  theme: 'light' | 'dark';
  aiAvailable: boolean;
  /** False when no transcription service is configured — the mic then uses the browser's own. */
  sttAvailable: boolean;
  /** The CRM could not be reached on start-up; the shell is running on cached identity. */
  offline: boolean;

  bootstrap: () => Promise<void>;
  /** `identifier` is an email address or a mobile number. */
  login: (identifier: string, password: string) => Promise<void>;
  /** Sign in with a device passkey (Face ID / Touch ID / Android biometrics). */
  loginWithPasskey: (useBrowserAutofill?: boolean) => Promise<void>;
  /** Fast unlock available only in the browser where the PIN was enrolled. */
  loginWithPin: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  setTheme: (theme: 'light' | 'dark') => void;
  moduleByName: (name: string) => ModuleSummary | undefined;
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('ipropy.theme', theme);
}

/*
  The eleven brand shades, generated from one admin-chosen hex.

  Rather than a colour-science library, this walks lightness in HSL around the
  chosen hue — the same relationship the shipped indigo scale has between its
  own steps. Two guarantees that matter more than fidelity:

   * the chosen hex is used verbatim for `--brand-500` (accents) and the
     closest generated step for 600 (buttons), so what the admin picked is
     what the CRM wears;
   * 50 stays a whisper and 950 stays near-black whatever the hue, because
     those two carry "tinted background" and "dark tinted background" and a
     saturated either would shout.
*/
export function applyBrandColour(hex: string | null | undefined): void {
  const root = document.documentElement;
  /*
    The shipped indigo is never regenerated — the eleven values in styles.css
    are hand-tuned to clear WCAG AA, and a generator walking lightness lands a
    few percent off on exactly the steps buttons and links are tested against.
    Choosing it again (or clearing the setting) must be a no-op, not a repaint.
  */
  const isDefault = !hex || /^#6366f1$/i.test(hex.trim());
  if (isDefault || !/^#[0-9a-f]{6}$/i.test(hex)) {
    for (let i = 50; i <= 950; i += 50) root.style.removeProperty(`--brand-${i}`);
    return;
  }
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  // A grey (no hue) keeps neutral steps; a hue-less "brand" would otherwise
  // divide by zero below.
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const sat = s <= 0 ? 0 : Math.min(1, s * (l > 0.75 ? 0.7 : 1));
  const shade = (lightness: number, saturation = sat): string => {
    const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    // hsl → rgb, done inline so no colour library joins the bundle.
    const satV = saturation;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * satV;
    const hp = h / 60;
    const x = chroma * (1 - Math.abs((hp % 2) - 1));
    let r1 = 0; let g1 = 0; let b1 = 0;
    if (hp < 1) { r1 = chroma; g1 = x; }
    else if (hp < 2) { r1 = x; g1 = chroma; }
    else if (hp < 3) { g1 = chroma; b1 = x; }
    else if (hp < 4) { g1 = x; b1 = chroma; }
    else if (hp < 5) { r1 = x; b1 = chroma; }
    else { r1 = chroma; b1 = x; }
    const m = lightness - chroma / 2;
    return `#${[c(r1 + m), c(g1 + m), c(b1 + m)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };
  // The admin's own hex, untouched, where the eye lands on it.
  /*
    Contrast is enforced, not hoped for: the button step darkens until white
    text on it clears WCAG AA (4.5:1). A hue can be too light for that at any
    saturation — a lime or an amber — and a pretty ramp that stops short makes
    every button in the CRM illegible. Lightness walks down at most to 0.26,
    which every hue reaches AA at.
  */
  const contrastWithWhite = (rgb: [number, number, number]): number => {
    const lum = (v: number): number => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const l = 0.2126 * lum(rgb[0]) + 0.7152 * lum(rgb[1]) + 0.0722 * lum(rgb[2]);
    return (1.05) / (l + 0.05);
  };
  const hexRgb = (value: string): [number, number, number] => [
    parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16),
  ];
  let buttonLightness = Math.min(0.42, l);
  let buttonStep = shade(buttonLightness);
  while (contrastWithWhite(hexRgb(buttonStep)) < 4.5 && buttonLightness > 0.24) {
    buttonLightness -= 0.02;
    buttonStep = shade(buttonLightness);
  }

  const steps: Record<number, string> = {
    50: shade(0.96, Math.min(sat, 0.55)),
    100: shade(0.92, Math.min(sat, 0.6)),
    200: shade(0.84, Math.min(sat, 0.65)),
    300: shade(0.73),
    400: shade(0.62),
    500: hex,
    // Buttons paint white text on 600/700, so both are pushed darker than a
    // pretty ramp would put them — white needs ~4.5:1 and a light 600 misses.
    600: buttonStep,
    700: shade(Math.min(buttonLightness - 0.04, 0.32)),
    800: shade(0.27),
    900: shade(0.22),
    950: shade(0.16, Math.min(sat, 0.5)),
  };
  for (const [step, value] of Object.entries(steps)) {
    root.style.setProperty(`--brand-${step}`, value);
  }
}

function initialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('ipropy.theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Everything a successful sign-in has to do, whichever way it was proved.
 * Password and passkey differ only in how the token is obtained, so the rest
 * lives here rather than being written twice and drifting.
 */
const USER_CACHE_KEY = 'ipropy.user';
const MODULES_CACHE_KEY = 'ipropy.modules';

/**
 * The last person known to be signed in on this device.
 *
 * Only ever used to keep the shell rendering when the CRM is unreachable, so
 * the offline copy of their records is still keyed and readable. It is not a
 * credential and grants nothing: every request still carries the real token,
 * and the server is the only thing that decides what comes back.
 */
function cacheUser(user: AuthUser): void {
  try { localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user)); } catch { /* full or private */ }
}

/**
 * The nav, remembered.
 *
 * Without it an unreachable CRM comes up with an empty nav and no route to
 * anything — the shell technically running, and useless. These are labels and
 * icons, not data.
 */
function cacheModules(modules: ModuleSummary[]): void {
  try { localStorage.setItem(MODULES_CACHE_KEY, JSON.stringify(modules)); } catch { /* ignore */ }
}

function cachedModules(): ModuleSummary[] {
  try {
    const raw = localStorage.getItem(MODULES_CACHE_KEY);
    return raw ? JSON.parse(raw) as ModuleSummary[] : [];
  } catch {
    return [];
  }
}

function cachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? JSON.parse(raw) as AuthUser : null;
  } catch {
    return null;
  }
}

async function adoptSession(
  result: { token: string; refreshToken: string; user: AuthUser },
  set: (partial: Partial<AppState>) => void,
): Promise<void> {
  tokenStore.set(result.token);
  /*
    The refresh token is not stored. The login response set an httpOnly cookie
    carrying it, which the browser attaches to `/api/auth` on its own and no
    script can read. Anything left in localStorage would only be a second copy
    in the one place an attacker can reach.
  */
  tokenStore.forgetRefresh();
  /*
    ...except in the app, where there is no cookie to carry it. See
    `getStoredRefresh` in native.ts. Native storage is not reachable by a
    script on a page, which is the protection the cookie was bought for.
  */
  if (isNative) rememberRefresh(result.refreshToken);
  const modules = await api.modules();
  cacheUser(result.user);
  cacheModules(modules);
  set({ user: result.user, modules, offline: false });
  void api.aiStatus().then((s) => set({ aiAvailable: s.available, sttAvailable: s.speechToText === true })).catch(() => undefined);
}

export const useApp = create<AppState>((set, get) => ({
  user: null,
  modules: [],
  loading: true,
  theme: initialTheme(),
  aiAvailable: false,
  sttAvailable: false,
  offline: false,

  bootstrap: async () => {
    applyTheme(get().theme);

    if (!tokenStore.get()) {
      /*
        On the web an empty token means an empty session and the login screen
        is the right answer. In the app it usually does not: Android evicts a
        webview's localStorage under storage pressure, without warning and
        without touching native storage. The thirty-day refresh token sitting
        there is still perfectly good, so spend it rather than making somebody
        who signed in last week sign in again on a site visit.
      */
      const revived = isNative && cachedRefresh() ? await api.tryRefresh() : false;
      if (!revived) {
        set({ loading: false });
        return;
      }
    }
    try {
      const [user, modules] = await Promise.all([api.me(), api.modules()]);
      cacheUser(user);
      cacheModules(modules);
      set({ user, modules, offline: false, loading: false });

      // Non-critical capability probes — never block the app shell on these.
      void api.aiStatus().then((s) => set({ aiAvailable: s.available, sttAvailable: s.speechToText === true })).catch(() => undefined);

      if (user.theme === 'dark' || user.theme === 'light') {
        set({ theme: user.theme });
        applyTheme(user.theme);
      }
    } catch (err) {
      // "The server said no" and "I could not reach the server" are different
      // answers and were being treated as one. Walking into a lift, a basement
      // or a dead spot threw away a perfectly good session and dumped the rep
      // at the login screen — where, with no connection, they could not sign
      // back in either. The token stays; only an actual rejection clears it.
      if (err instanceof ApiError && err.status === 401) {
        tokenStore.clear();
        set({ user: null, loading: false });
        return;
      }
      // Unreachable, not unauthenticated. Come up with whoever was last signed
      // in, so the offline copy of their leads is reachable.
      set({ user: cachedUser(), modules: cachedModules(), offline: true, loading: false });
    }
  },

  login: async (identifier, password) => {
    await adoptSession(await api.login(identifier, password), set);
  },

  loginWithPasskey: async (useBrowserAutofill = false) => {
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const options = await api.passkeyLoginOptions();
    // The browser shows the biometric prompt here; it rejects if the user
    // cancels, which the caller treats as "not an error worth shouting about".
    const assertion = await startAuthentication({ optionsJSON: options as never, useBrowserAutofill });
    await adoptSession(await api.passkeyLoginVerify(assertion), set);
  },

  loginWithPin: async (pin) => {
    await adoptSession(await api.pinLogin(pin), set);
  },

  logout: async () => {
    await api.logout().catch(() => undefined);
    // A shared handset on an office desk is normal in this business, so the
    // offline copy must not outlive the session that fetched it.
    await forgetAll().catch(() => undefined);
    try {
      localStorage.removeItem(USER_CACHE_KEY);
      localStorage.removeItem(MODULES_CACHE_KEY);
    } catch { /* ignore */ }
    tokenStore.clear();
    if (isNative) rememberRefresh(null);
    set({ user: null, modules: [] });
    window.location.href = '/login';
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
    void api.updateProfile({ theme }).catch(() => undefined);
  },

  moduleByName: (name) => get().modules.find((m) => m.name === name),
}));

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  title: string;
  body?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { ...toast, id }] });
    setTimeout(() => get().dismiss(id), toast.kind === 'error' ? 7000 : 4000);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  success: (title: string, body?: string) => useToasts.getState().push({ kind: 'success', title, body }),
  error: (title: string, body?: string) => useToasts.getState().push({ kind: 'error', title, body }),
  info: (title: string, body?: string) => useToasts.getState().push({ kind: 'info', title, body }),
};
