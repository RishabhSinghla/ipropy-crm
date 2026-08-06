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
  login: (email: string, password: string) => Promise<void>;
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

  login: async (email, password) => {
    const result = await api.login(email, password);
    tokenStore.set(result.token);
    tokenStore.setRefresh(result.refreshToken);
    const modules = await api.modules();
    set({ user: result.user, modules });
    void api.aiStatus().then((s) => set({ aiAvailable: s.available })).catch(() => undefined);
    void api.telephonyStatus().then((s) => set({ telephonyAvailable: s.configured })).catch(() => undefined);
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
