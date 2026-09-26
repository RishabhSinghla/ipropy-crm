import { describe, expect, it } from 'vitest';
import {
  deckStatus, elapsedLabel, followUpFor, mayControlLiveCall, minutesFrom, outcomeCard, splitOutcomes,
} from '../src/lib/callConsole';

describe('the call console', () => {
  it('draws the six outcomes the team uses', () => {
    expect(outcomeCard('Interested').chip).toBe('Priority');
    expect(outcomeCard('No Answer').icon).toBe('noring');
    expect(outcomeCard('Not Interested').disqualifies).toBe(true);
    expect(outcomeCard('Wrong Number').icon).toBe('invalid');
  });

  it('still draws an outcome an admin invented after this was written', () => {
    // The alternative is a rep who cannot record what actually happened.
    const card = outcomeCard('Site Visit Fixed');
    expect(card.hint).toBe('Site Visit Fixed');
    expect(card.disqualifies).toBeUndefined();
  });

  it('reads an unfamiliar outcome by its words rather than giving up', () => {
    expect(outcomeCard('Number not reachable').icon).toBe('unreachable');
    expect(outcomeCard('Junk lead').disqualifies).toBe(true);
  });

  it('counts the call the way a clock does', () => {
    expect(elapsedLabel(130_000)).toBe('02:10');
    expect(elapsedLabel(0)).toBe('00:00');
    expect(elapsedLabel(3_849_000)).toBe('1:04:09');
  });

  it('never offers to end a call the app cannot end', () => {
    // Android only lets the default phone app touch a running call.
    expect(mayControlLiveCall(undefined)).toBe(false);
    expect(mayControlLiveCall({})).toBe(false);
    expect(mayControlLiveCall({ endCall: true })).toBe(true);
  });

  it('a short call is a minute, never nothing', () => {
    const start = 1_000_000;
    expect(minutesFrom(start, start + 30_000, 1)).toBe(1);
    expect(minutesFrom(start, start + 400_000, 1)).toBe(7);
    // Nothing timed: whatever the rep typed stands.
    expect(minutesFrom(null, start, 3)).toBe(3);
  });
});

describe('when the outcome chases them for you', () => {
  const now = new Date('2026-09-21T10:00:00.000Z');

  it('a call-back schedules itself two hours out', () => {
    expect(followUpFor('Call Back Later', null, now)).toBe('2026-09-21T12:00:00.000Z');
  });

  it('an outcome with no offset schedules nothing', () => {
    expect(followUpFor('Interested', null, now)).toBeNull();
    expect(followUpFor('Not Interested', null, now)).toBeNull();
  });

  it('never overwrites a date somebody has already chosen', () => {
    // A site visit booked for Saturday must not become a call-back in two hours.
    expect(followUpFor('Call Back Later', '2026-09-26T11:00:00.000Z', now)).toBeNull();
  });

  it('but does replace one that has already been and gone', () => {
    expect(followUpFor('Call Back Later', '2026-09-01T11:00:00.000Z', now)).toBe('2026-09-21T12:00:00.000Z');
  });

  it('the chip and the schedule cannot disagree', () => {
    // Both are read off the same card, so a card saying "In 2 hours" with a
    // follow-up landing tomorrow is not expressible.
    const card = outcomeCard('Call Back Later');
    expect(card.chip).toBe('In 2 hours');
    expect(card.followUpInHours).toBe(2);
  });
});

describe('six on the row, the rest a tap away', () => {
  const all = [
    'Interested', 'Not Interested', 'Call Back Later', 'Site Visit Scheduled',
    'Budget Mismatch', 'Location Mismatch', 'Already Purchased', 'Wrong Number',
    'Not Reachable', 'Switched Off', 'Busy', 'Language Barrier', 'Do Not Call',
  ];

  it('shows six of the thirteen first', () => {
    const { first, rest } = splitOutcomes(all, 'Call Back Later');
    expect(first).toHaveLength(6);
    expect(first).toContain('Interested');
    expect(first).toContain('Not Interested');
    expect(rest).toContain('Site Visit Scheduled');
    expect(first.length + rest.length).toBe(all.length);
  });

  it('never hides the outcome that is currently chosen', () => {
    // Picking one from "more" and watching it disappear off the row showing it
    // as chosen is the bug this exists to prevent.
    const { first, rest } = splitOutcomes(all, 'Site Visit Scheduled');
    expect(first).toContain('Site Visit Scheduled');
    expect(rest).not.toContain('Site Visit Scheduled');
    expect(first).toHaveLength(6);
  });
});

describe('the words at the top of the call deck', () => {
  const pressedAt = 1_000_000;
  const call = { pressedAt, placing: false };
  const report = (state: 'dialling' | 'ringing' | 'active' | 'held' | 'ended', extra: Partial<{ connectedAt: number; talkedSeconds: number }> = {}) => ({
    state, connectedAt: extra.connectedAt ?? null, talkedSeconds: extra.talkedSeconds ?? null, reportedAt: pressedAt + 2_000,
  });

  it('says Calling while the CRM is still asking the phone', () => {
    expect(deckStatus(null, { pressedAt, placing: true }, pressedAt)).toEqual({ label: 'Calling…', ticking: false });
  });

  it('shows Ringing, with no clock, until they pick up', () => {
    expect(deckStatus(report('dialling'), call, pressedAt + 20_000)).toEqual({ label: 'Ringing…', ticking: false });
  });

  it('starts the clock from when they answered, not from when Call was pressed', () => {
    const answered = pressedAt + 12_000;
    expect(deckStatus(report('active', { connectedAt: answered }), call, answered + 65_000)).toEqual({ label: '01:05', ticking: true });
  });

  it('says On hold and keeps the clock', () => {
    expect(deckStatus(report('held', { connectedAt: pressedAt }), call, pressedAt + 30_000).label).toBe('On hold · 00:30');
  });

  it('says how long they talked once it ends, or that nobody answered', () => {
    expect(deckStatus(report('ended', { talkedSeconds: 95 }), call, pressedAt).label).toBe('Call ended · 01:35');
    expect(deckStatus(report('ended'), call, pressedAt).label).toBe('Not answered');
  });

  it('shows no clock when the phone says nothing about this call', () => {
    expect(deckStatus(null, call, pressedAt + 60_000)).toEqual({ label: 'Calling on your phone', ticking: false });
    const lastCall = { ...report('active', { connectedAt: 0 }), reportedAt: pressedAt - 60_000 };
    expect(deckStatus(lastCall, call, pressedAt + 60_000).label).toBe('Calling on your phone');
  });
});
