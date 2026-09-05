import { create } from 'zustand';
import type { AuthUser } from '@ipropy/shared';
import { ApiError, api, tokenStore, type ModuleSummary } from './api';
import { forgetAll } from './offlineCache';

interface AppState {
  user: AuthUser | null;
  modules: ModuleSummary[];
  loading: boolean;
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  aiAvailable: boolean;
  telephonyAvailable: boolean;
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
  toggleSidebar: () => void;
  moduleByName: (name: string) => ModuleSummary | undefined;
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('ipropy.theme', theme);
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
 * Without it an unreachable CRM comes up with an empty sidebar and no route to
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
  const modules = await api.modules();
  cacheUser(result.user);
  cacheModules(modules);
  set({ user: result.user, modules, offline: false });
  void api.aiStatus().then((s) => set({ aiAvailable: s.available })).catch(() => undefined);
  void api.telephonyStatus().then((s) => set({ telephonyAvailable: s.configured })).catch(() => undefined);
}

export const useApp = create<AppState>((set, get) => ({
  user: null,
  modules: [],
  loading: true,
  theme: initialTheme(),
  /*
    Collapsed unless this browser has been told otherwise.

    The rail is a way to change screen, not something to read, and every module
    has an icon. Starting expanded spent 13rem of a laptop screen on labels
    somebody learns in a day — so the default flipped, and the stored value is
    now what *opens* it rather than what closes it.
  */
  sidebarCollapsed: localStorage.getItem('ipropy.sidebar') !== 'expanded',
  aiAvailable: false,
  telephonyAvailable: false,
  offline: false,

  bootstrap: async () => {
    applyTheme(get().theme);

    if (!tokenStore.get()) {
      set({ loading: false });
      return;
    }
    try {
      const [user, modules] = await Promise.all([api.me(), api.modules()]);
      cacheUser(user);
      cacheModules(modules);
      set({ user, modules, offline: false, loading: false });

      // Non-critical capability probes — never block the app shell on these.
      void api.aiStatus().then((s) => set({ aiAvailable: s.available })).catch(() => undefined);
      void api.telephonyStatus().then((s) => set({ telephonyAvailable: s.configured })).catch(() => undefined);

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
    set({ user: null, modules: [] });
    window.location.href = '/login';
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
    void api.updateProfile({ theme }).catch(() => undefined);
  },

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    localStorage.setItem('ipropy.sidebar', next ? 'collapsed' : 'expanded');
    set({ sidebarCollapsed: next });
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
