import { create } from 'zustand';
import type { AuthUser } from '@ipropy/shared';
import { api, tokenStore, type ModuleSummary } from './api';

interface AppState {
  user: AuthUser | null;
  modules: ModuleSummary[];
  loading: boolean;
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  aiAvailable: boolean;
  telephonyAvailable: boolean;

  bootstrap: () => Promise<void>;
  /** `identifier` is an email address or a mobile number. */
  login: (identifier: string, password: string) => Promise<void>;
  /** Sign in with a device passkey (Face ID / Touch ID / Android biometrics). */
  loginWithPasskey: () => Promise<void>;
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
async function adoptSession(
  result: { token: string; refreshToken: string; user: AuthUser },
  set: (partial: Partial<AppState>) => void,
): Promise<void> {
  tokenStore.set(result.token);
  tokenStore.setRefresh(result.refreshToken);
  const modules = await api.modules();
  set({ user: result.user, modules });
  void api.aiStatus().then((s) => set({ aiAvailable: s.available })).catch(() => undefined);
  void api.telephonyStatus().then((s) => set({ telephonyAvailable: s.configured })).catch(() => undefined);
}

export const useApp = create<AppState>((set, get) => ({
  user: null,
  modules: [],
  loading: true,
  theme: initialTheme(),
  sidebarCollapsed: localStorage.getItem('ipropy.sidebar') === 'collapsed',
  aiAvailable: false,
  telephonyAvailable: false,

  bootstrap: async () => {
    applyTheme(get().theme);

    if (!tokenStore.get()) {
      set({ loading: false });
      return;
    }
    try {
      const [user, modules] = await Promise.all([api.me(), api.modules()]);
      set({ user, modules, loading: false });

      // Non-critical capability probes — never block the app shell on these.
      void api.aiStatus().then((s) => set({ aiAvailable: s.available })).catch(() => undefined);
      void api.telephonyStatus().then((s) => set({ telephonyAvailable: s.configured })).catch(() => undefined);

      if (user.theme === 'dark' || user.theme === 'light') {
        set({ theme: user.theme });
        applyTheme(user.theme);
      }
    } catch {
      tokenStore.clear();
      set({ user: null, loading: false });
    }
  },

  login: async (identifier, password) => {
    await adoptSession(await api.login(identifier, password), set);
  },

  loginWithPasskey: async () => {
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const options = await api.passkeyLoginOptions();
    // The browser shows the biometric prompt here; it rejects if the user
    // cancels, which the caller treats as "not an error worth shouting about".
    const assertion = await startAuthentication({ optionsJSON: options as never });
    await adoptSession(await api.passkeyLoginVerify(assertion), set);
  },

  logout: async () => {
    await api.logout().catch(() => undefined);
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
