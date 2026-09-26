/**
 * The call a rep is on, held once for the whole CRM.
 *
 * **26 September 2026, the owner:** the call deck *"should be persisted all
 * around the CRM whenever and wherever I drag it … and it should not get
 * disappeared like right now."* It used to belong to the record page that
 * placed the call, so leaving that page threw the call away mid-sentence —
 * notes, outcome and clock. The call lives here now, and the deck is drawn
 * once by the app's shell, so it follows the rep to any screen until they
 * save it.
 *
 * What the phone itself is doing (ringing, answered, speaker, mute, hold)
 * is not kept here: that is the phone's to say, and it arrives from the
 * server as `LiveCallState`. This is only what the CRM started.
 */
import { create } from 'zustand';

export interface CrmCall {
  /** The number that was rung, as the record holds it. */
  number: string;
  /** The record the call is about — where it is saved and what Save & Next moves on from. */
  module: string;
  recordId: string;
  /** Which date field the outcome's chase date is written to on this module. */
  followUpField: string;
  /** When Call was pressed, on this computer's clock. */
  pressedAt: number;
  /** True while the CRM is still asking the phone to ring. */
  placing: boolean;
  outcome: string | null;
}

interface LiveCallStore {
  call: CrmCall | null;
  begin: (call: Omit<CrmCall, 'placing' | 'outcome' | 'pressedAt'>) => void;
  update: (changes: Partial<CrmCall>) => void;
  finish: () => void;
}

/*
  Kept in this browser as well, so a refresh mid-call brings the deck straight
  back with the outcome already chosen. Guarded: a browser that refuses
  storage still gets a working deck, only one that a refresh forgets.
*/
const KEY = 'ipropy.liveCall';

function remembered(): CrmCall | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const call = JSON.parse(raw) as CrmCall;
    // A call pressed more than six hours ago was not saved and is not live.
    if (!call?.recordId || Date.now() - call.pressedAt > 6 * 60 * 60 * 1000) return null;
    return { ...call, placing: false };
  } catch {
    return null;
  }
}

function remember(call: CrmCall | null): void {
  try {
    if (call) localStorage.setItem(KEY, JSON.stringify(call));
    else localStorage.removeItem(KEY);
  } catch { /* nothing to keep it in */ }
}

export const useLiveCall = create<LiveCallStore>((set, get) => ({
  call: remembered(),
  begin: (call) => {
    set({ call: { ...call, pressedAt: Date.now(), placing: true, outcome: null } });
    remember(get().call);
  },
  update: (changes) => {
    set((current) => (current.call ? { call: { ...current.call, ...changes } } : current));
    remember(get().call);
  },
  finish: () => {
    set({ call: null });
    remember(null);
  },
}));
