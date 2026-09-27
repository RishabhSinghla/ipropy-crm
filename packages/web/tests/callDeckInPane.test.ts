/**
 * @vitest-environment jsdom
 *
 * The store reads `localStorage` as it is constructed — that is what makes a
 * refresh mid-call bring the deck straight back — so importing it at all
 * needs a browser. The web suite runs on `node` except where a file asks.
 *
 * The record pane holds the working deck and the shell offers a return link
 * on other pages. The draft stays with the call when the pane unmounts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveCall } from '../src/lib/liveCall';

const CALL = {
  userId: 'agent-a',
  number: '+919999999999',
  module: 'leads',
  recordId: 'rec-1',
  followUpField: 'next_followup_at',
};

describe('the call deck in the record pane', () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveCall.getState().finish();
  });

  it('starts with the return link showing, because no pane has claimed the call', () => {
    useLiveCall.getState().begin(CALL);
    expect(useLiveCall.getState().inPane).toBe(false);
  });

  it('hides the return link while a pane is showing the call, and brings it back', () => {
    useLiveCall.getState().begin(CALL);
    useLiveCall.getState().setInPane(true);
    expect(useLiveCall.getState().inPane).toBe(true);

    // Navigating away from the record unmounts the pane.
    useLiveCall.getState().setInPane(false);
    expect(useLiveCall.getState().inPane).toBe(false);
    expect(useLiveCall.getState().call?.recordId).toBe('rec-1');
  });

  it('clears the claim when the call is finished', () => {
    useLiveCall.getState().begin(CALL);
    useLiveCall.getState().setInPane(true);
    useLiveCall.getState().finish();

    expect(useLiveCall.getState().call).toBeNull();
    // Without this the next call started from the dashboard would have no return link.
    expect(useLiveCall.getState().inPane).toBe(false);
  });

  it('never remembers the claim, because it is true of a screen and not of the call', () => {
    useLiveCall.getState().begin(CALL);
    useLiveCall.getState().setInPane(true);

    const kept = JSON.parse(localStorage.getItem('ipropy.liveCall') ?? '{}') as Record<string, unknown>;
    expect(kept.recordId).toBe('rec-1');
    expect(kept).not.toHaveProperty('inPane');
  });

  it('keeps the owning agent with the call so another signed-in user cannot inherit it', () => {
    useLiveCall.getState().begin(CALL);
    expect(useLiveCall.getState().call?.userId).toBe('agent-a');
    const saved = JSON.parse(localStorage.getItem('ipropy.liveCall') ?? '{}') as Record<string, unknown>;
    expect(saved.userId).toBe('agent-a');
  });

  it('keeps notes and the chosen follow-up through a route change and browser reload', async () => {
    useLiveCall.getState().begin(CALL);
    useLiveCall.getState().update({ notes: 'Asked for a floor plan', chaseOverride: '2026-09-29' });
    useLiveCall.getState().setInPane(true);
    useLiveCall.getState().setInPane(false);

    const saved = JSON.parse(localStorage.getItem('ipropy.liveCall') ?? '{}') as Record<string, unknown>;
    expect(saved.notes).toBe('Asked for a floor plan');
    expect(saved.chaseOverride).toBe('2026-09-29');

    // A fresh import constructs the store from storage, as a browser reload does.
    vi.resetModules();
    const restored = await import('../src/lib/liveCall');
    expect(restored.useLiveCall.getState().call?.notes).toBe('Asked for a floor plan');
    expect(restored.useLiveCall.getState().call?.chaseOverride).toBe('2026-09-29');
  });
});
