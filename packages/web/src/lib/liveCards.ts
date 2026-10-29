/**
 * The cards in the bottom-right corner: a customer wrote, or the phone is ringing.
 *
 * Everything that decides *what to show* is a plain function here, so a test can
 * read it without a browser. The store, the sound and the desktop notice are the
 * thin part around them.
 *
 * Who is told is not decided here: the server only sends a WhatsApp notice to the
 * lead's owner (or every admin when nobody owns it), and a ringing phone only
 * reports to its own rep. This file trusts that and never widens it.
 */
import { create } from 'zustand';
import { currentSubscription } from './push';
import type { LiveCallState } from './api';

export interface CardMessage { id: string; text: string }

export interface MessageCard {
  kind: 'whatsapp';
  /** The conversation: several messages from one person fold into one card. */
  id: string;
  recordId: string | null;
  module: string;
  handle: string;
  name: string;
  messages: CardMessage[];
  /** Bumped on every new message so the auto-dismiss clock starts again. */
  touched: number;
}

export type CallPhase = 'ringing' | 'missed';

export interface CallCard {
  kind: 'call';
  id: 'incoming-call';
  number: string;
  name: string | null;
  recordId: string | null;
  module: string | null;
  phase: CallPhase;
  canDecline: boolean;
  touched: number;
}

export type LiveCard = MessageCard | CallCard;

export interface IncomingWhatsApp {
  id?: string;
  body?: string | null;
  recordId?: string | null;
  conversationId?: string;
  handle?: string;
  contactName?: string;
  module?: string;
}

/** How many lines of one person's messages a card keeps. */
export const MAX_LINES = 3;
/** How many cards can be on screen at once; older ones wait their turn. */
export const MAX_CARDS = 4;
export const AUTO_DISMISS_MS = 8_000;

/** Folds a new message into the card list: one card per person, newest line last. */
export function withMessage(cards: LiveCard[], note: IncomingWhatsApp, now: number): LiveCard[] {
  if (!note.conversationId) return cards;
  const line: CardMessage = { id: note.id ?? `${now}`, text: (note.body ?? '').trim() || 'New message' };
  const existing = cards.find((card): card is MessageCard => card.kind === 'whatsapp' && card.id === note.conversationId);
  if (existing) {
    if (existing.messages.some((message) => message.id === line.id)) return cards;
    const next: MessageCard = { ...existing, messages: [...existing.messages, line].slice(-MAX_LINES), touched: now };
    return cards.map((card) => (card === existing ? next : card));
  }
  const fresh: MessageCard = {
    kind: 'whatsapp', id: note.conversationId, recordId: note.recordId ?? null, module: note.module ?? 'leads',
    handle: note.handle ?? '', name: note.contactName || note.handle || 'WhatsApp', messages: [line], touched: now,
  };
  return [...cards, fresh].slice(-MAX_CARDS);
}

/** True when the person is already looking at this very chat, so a card would only interrupt. */
export function chatIsInView(openRecordId: string | null, noteRecordId: string | null | undefined, focused: boolean): boolean {
  return focused && Boolean(openRecordId) && openRecordId === noteRecordId;
}

/** What a phone report means for the ringing card: show it, turn it into "missed", or take it away. */
export function nextCallCard(current: CallCard | null, live: LiveCallState, now: number): { card: CallCard | null; changed: boolean } {
  const incoming = live.direction === 'incoming' || live.direction === 'in';
  if (live.state === 'ringing' && incoming && live.number) {
    if (current?.phase === 'ringing' && current.number === live.number) {
      return { card: { ...current, canDecline: live.canEndCall }, changed: false };
    }
    return {
      card: { kind: 'call', id: 'incoming-call', number: live.number, name: null, recordId: null, module: null, phase: 'ringing', canDecline: live.canEndCall, touched: now },
      changed: true,
    };
  }
  if (!current) return { card: null, changed: false };
  if (current.phase === 'ringing' && live.state === 'ended' && !live.talkedSeconds) {
    return { card: { ...current, phase: 'missed', touched: now }, changed: true };
  }
  if (current.phase === 'ringing' && (live.state === 'active' || live.state === 'ended' || live.state === 'held')) {
    return { card: null, changed: true };
  }
  return { card: current, changed: false };
}

/** Says whether the card should vanish by itself. A ringing phone never does; nor does anything being hovered. */
export function mayAutoDismiss(card: LiveCard, hovered: boolean): boolean {
  if (hovered) return false;
  return card.kind === 'whatsapp';
}

const MUTE_KEY = 'ipropy.live.muted';
function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

interface LiveCardStore {
  cards: LiveCard[];
  /** The record whose WhatsApp tab is on screen right now, if any. */
  openChatRecordId: string | null;
  muted: boolean;
  pushWhatsApp: (note: IncomingWhatsApp) => boolean;
  setCall: (card: CallCard | null) => void;
  patchCall: (changes: Partial<CallCard>) => void;
  dismiss: (id: string) => void;
  setOpenChat: (recordId: string | null) => void;
  toggleMute: () => void;
}

export const useLiveCards = create<LiveCardStore>((set, get) => ({
  cards: [],
  openChatRecordId: null,
  muted: readMuted(),
  pushWhatsApp: (note) => {
    if (chatIsInView(get().openChatRecordId, note.recordId, document.hasFocus() && document.visibilityState === 'visible')) return false;
    const before = get().cards;
    const after = withMessage(before, note, Date.now());
    if (after === before) return false;
    set({ cards: after });
    return true;
  },
  setCall: (card) => set({ cards: [...get().cards.filter((c) => c.kind !== 'call'), ...(card ? [card] : [])] }),
  patchCall: (changes) => set({ cards: get().cards.map((c) => (c.kind === 'call' ? { ...c, ...changes } : c)) }),
  dismiss: (id) => set({ cards: get().cards.filter((c) => c.id !== id) }),
  setOpenChat: (openChatRecordId) => set({ openChatRecordId }),
  toggleMute: () => {
    const muted = !get().muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* the mute still holds for this tab */ }
    set({ muted });
  },
}));

// --- Across tabs: only one of them makes a noise or a desktop notice ----------

const TAB_ID = Math.random().toString(36).slice(2);

/** The first tab to claim an event wins it; every other tab stays quiet about it. */
export function claimOnce(eventId: string): boolean {
  const key = `ipropy.live.claim.${eventId}`;
  try {
    const seen = localStorage.getItem(key);
    if (seen) return seen === TAB_ID;
    localStorage.setItem(key, TAB_ID);
    window.setTimeout(() => { try { localStorage.removeItem(key); } catch { /* ignore */ } }, 60_000);
    return localStorage.getItem(key) === TAB_ID;
  } catch {
    return true;
  }
}

let channel: BroadcastChannel | null = null;
/** Dismissing a card in one tab clears it in the others too. */
export function listenForDismissals(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  channel = new BroadcastChannel('ipropy-live-cards');
  channel.onmessage = (event: MessageEvent<{ dismiss?: string }>) => {
    if (event.data?.dismiss) useLiveCards.setState((s) => ({ cards: s.cards.filter((c) => c.id !== event.data.dismiss) }));
  };
  return () => { channel?.close(); channel = null; };
}
export function dismissEverywhere(id: string): void {
  useLiveCards.getState().dismiss(id);
  channel?.postMessage({ dismiss: id });
}

// --- Sound and desktop notice -------------------------------------------------

let audio: AudioContext | null = null;
/** A soft two-note chime, made in the browser so there is no file to ship or block. */
export function chime(kind: 'message' | 'ring'): void {
  if (useLiveCards.getState().muted) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const notes = kind === 'ring' ? [660, 880, 660, 880] : [880, 1175];
    notes.forEach((hz, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      const start = audio!.currentTime + i * 0.16;
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.06, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
      osc.connect(gain).connect(audio!.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    });
  } catch { /* a browser that will not play sound before a click just stays quiet */ }
}

/** A desktop notice, only when this tab is hidden, permission was given, and push is not already showing one. */
export async function desktopNotice(eventId: string, title: string, body: string, link: string): Promise<void> {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (await currentSubscription().catch(() => null)) return;
  if (!claimOnce(`n-${eventId}`)) return;
  const shown = new Notification(title, { body, tag: eventId, icon: '/icons/icon-192.png' });
  shown.onclick = () => { window.focus(); window.location.assign(link); shown.close(); };
}
