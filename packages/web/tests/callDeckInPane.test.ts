/**
 * @vitest-environment jsdom
 *
 * The store reads `localStorage` as it is constructed — that is what makes a
 * refresh mid-call bring the deck straight back — so importing it at all
 * needs a browser. The web suite runs on `node` except where a file asks.
 *
 * One call, one face.
 *
 * The record's own pane draws the whole deck; the floating bar is for every
 * other screen. Both at once is a call wearing two faces, and the bar sits
 * over the very header it docks beside — which is what the owner was looking
 * at on 26 September 2026 when he asked for the deck to live in the pane.
 *
 * `inPane` is the flag that decides, and the two things worth pinning about
 * it are that it is a fact about a *screen* rather than about the call — so
 * it is never remembered across a reload — and that finishing a call clears
 * it, or the bar would stay hidden for the next call started somewhere else.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('starts with the bar showing, because no pane has claimed the call', () => {
    useLiveCall.getState().begin(CALL);
    expect(useLiveCall.getState().inPane).toBe(false);
  });

  it('stands the bar down while a pane is showing the call, and brings it back', () => {
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
    // Without this the next call started from the dashboard would have no bar.
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
});
