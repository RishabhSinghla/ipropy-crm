import { create } from 'zustand';

export type ProgressiveDialerStatus = 'waiting' | 'paused' | 'completed' | 'stopped';

export interface ProgressiveDialerItem {
  id: string;
  label: string;
  number: string;
}

export interface ProgressiveDialerSession {
  userId: string;
  module: string;
  items: ProgressiveDialerItem[];
  index: number;
  status: ProgressiveDialerStatus;
  sourceUrl: string;
  startedAt: number;
  updatedAt: number;
}

interface ProgressiveDialerStore {
  session: ProgressiveDialerSession | null;
  start: (session: Omit<ProgressiveDialerSession, 'index' | 'status' | 'startedAt' | 'updatedAt'>) => void;
  pause: () => void;
  resume: () => void;
  advance: (pauseAfter?: boolean) => ProgressiveDialerItem | null;
  stop: () => void;
  clear: () => void;
}

const KEY = 'ipropy.progressiveDialer';
const MAX_AGE = 24 * 60 * 60 * 1000;

function remembered(): ProgressiveDialerSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as ProgressiveDialerSession;
    if (!session?.userId || !session.module || !session.items?.length || Date.now() - session.updatedAt > MAX_AGE) {
      localStorage.removeItem(KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function remember(session: ProgressiveDialerSession | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch { /* A blocked browser store must not disable calling. */ }
}

export function progressiveRecordUrl(session: ProgressiveDialerSession, item: ProgressiveDialerItem): string {
  const target = new URL(session.sourceUrl || `/${encodeURIComponent(session.module)}`, 'https://crm.local');
  target.searchParams.set('open', item.id);
  target.searchParams.delete('dial');
  return `${target.pathname}${target.search}`;
}

export const useProgressiveDialer = create<ProgressiveDialerStore>((set, get) => ({
  session: remembered(),
  start: (input) => {
    const now = Date.now();
    const session: ProgressiveDialerSession = {
      ...input,
      index: 0,
      status: 'waiting',
      startedAt: now,
      updatedAt: now,
    };
    set({ session });
    remember(session);
  },
  pause: () => {
    const current = get().session;
    if (!current || current.status === 'completed' || current.status === 'stopped') return;
    const session = { ...current, status: 'paused' as const, updatedAt: Date.now() };
    set({ session });
    remember(session);
  },
  resume: () => {
    const current = get().session;
    if (!current || (current.status !== 'paused' && current.status !== 'stopped')) return;
    const session = { ...current, status: 'waiting' as const, updatedAt: Date.now() };
    set({ session });
    remember(session);
  },
  advance: (pauseAfter = false) => {
    const current = get().session;
    if (!current || current.status === 'completed' || current.status === 'stopped') return null;
    const nextIndex = current.index + 1;
    const done = nextIndex >= current.items.length;
    const session: ProgressiveDialerSession = {
      ...current,
      index: done ? current.items.length : nextIndex,
      status: done ? 'completed' : pauseAfter ? 'paused' : 'waiting',
      updatedAt: Date.now(),
    };
    set({ session });
    remember(session);
    return done ? null : session.items[nextIndex];
  },
  stop: () => {
    const current = get().session;
    if (!current) return;
    const session = { ...current, status: 'stopped' as const, updatedAt: Date.now() };
    set({ session });
    remember(session);
  },
  clear: () => {
    set({ session: null });
    remember(null);
  },
}));
