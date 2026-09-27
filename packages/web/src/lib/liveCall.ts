/**
 * The call a rep is on, held once for the whole CRM.
 *
 * **26 September 2026, the owner:** the call deck *"should be persisted all
 * around the CRM whenever and wherever I drag it … and it should not get
 * disappeared like right now."* It used to belong to the record page that
 * placed the call, so leaving that page threw the call away mid-sentence —
 * notes, outcome and clock. The call and its drafts live here; the shell
 * offers a route back to its record until the rep saves it.
 *
 * What the phone itself is doing (ringing, answered, speaker, mute, hold)
 * is not kept here: that is the phone's to say, and it arrives from the
 * server as `LiveCallState`. This is only what the CRM started.
 */
import { create } from 'zustand';

export interface CrmCall {
  /** The authenticated rep who started this call; never share it across CRM users. */
  userId: string;
  /** The number that was rung, as the record holds it. */
  number: string;
  /** The record the call is about — where it is saved and what Save & Next moves on from. */
  module: string;
  recordId: string;
  /** Which date field the outcome's chase date is written to on this module. */
  followUpField: string;
  /** Queue-aware Save & Next snapshot, captured from the active split view. */
  queueNextId?: string | null;
  queuePosition?: number | null;
  queueTotal?: number | null;
  queueUrl?: string | null;
  /** When Call was pressed, on this computer's clock. */
  pressedAt: number;
  /** True while the CRM is still asking the phone to ring. */
  placing: boolean;
  outcome: string | null;
  /** Drafts survive moving between records or refreshing during a call. */
  notes?: string;
  chaseOverride?: string | null;
}

interface LiveCallStore {
  call: CrmCall | null;
  begin: (call: Omit<CrmCall, 'placing' | 'outcome' | 'pressedAt'>) => void;
  update: (changes: Partial<CrmCall>) => void;
  finish: () => void;
  /*
    Whether the record's own pane is showing the call in full.

    The shell's return link appears only away from the record's call pane.
    This flag is deliberately not remembered: it describes a screen, not a call.
  */
  inPane: boolean;
  setInPane: (on: boolean) => void;
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
    // Old pre-isolation entries have no owner and are discarded. Also avoid
    // reviving a call pressed more than six hours ago.
    if (!call?.userId || !call.recordId || Date.now() - call.pressedAt > 6 * 60 * 60 * 1000) {
      localStorage.removeItem(KEY);
      return null;
    }
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
    set({ call: { ...call, pressedAt: Date.now(), placing: true, outcome: null, notes: '', chaseOverride: undefined } });
    remember(get().call);
  },
  update: (changes) => {
    set((current) => (current.call ? { call: { ...current.call, ...changes } } : current));
    remember(get().call);
  },
  finish: () => {
    set({ call: null, inPane: false });
    remember(null);
  },
  inPane: false,
  setInPane: (on) => set({ inPane: on }),
}));
