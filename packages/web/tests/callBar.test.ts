/**
 * The call bar that replaced nine words that never changed.
 *
 * **27 September 2026, the owner:** *"We need a call Bar and Call timer in
 * replacement of 'calling on your phone' in the call deck."* That sentence was
 * on screen for the whole of every call this business makes, because every
 * installed copy of the app predates the plugin that reports a call's state.
 *
 * The rule worth pinning is the honest one: the clock always counts from when
 * Call was pressed, which this computer knows for certain, and talk time
 * appears **only** when the phone has said so. A duration the CRM invented
 * would end up in a report.
 */
import { describe, expect, it } from 'vitest';
import { callBar, type PhoneCallReport } from '../src/lib/callConsole';

const PRESSED = 1_700_000_000_000;
const call = { pressedAt: PRESSED, placing: false };

function report(over: Partial<PhoneCallReport>): PhoneCallReport {
  return { state: 'active', connectedAt: null, reportedAt: PRESSED + 1_000, talkedSeconds: null, ...over } as PhoneCallReport;
}

describe('the call bar', () => {
  it('counts from when Call was pressed even when the phone says nothing', () => {
    const bar = callBar(null, call, PRESSED + 95_000);
    expect(bar.elapsed).toBe('01:35');
    // Nothing is known, so nothing is claimed — this is where the nine words were.
    expect(bar.phase).toBeNull();
    expect(bar.talkTime).toBeNull();
    expect(bar.moving).toBe(true);
  });

  it('never invents a talk time', () => {
    const bar = callBar(report({ state: 'active', connectedAt: null }), call, PRESSED + 60_000);
    expect(bar.talkTime).toBeNull();
    expect(bar.elapsed).toBe('01:00');
  });

  it('counts the conversation once the phone says when it started', () => {
    const bar = callBar(report({ state: 'active', connectedAt: PRESSED + 20_000 }), call, PRESSED + 80_000);
    expect(bar.talkTime).toBe('01:00');
    expect(bar.connected).toBe(true);
  });

  it('holds still once the call is over', () => {
    const bar = callBar(report({ state: 'ended', talkedSeconds: 65 }), call, PRESSED + 200_000);
    expect(bar.phase).toBe('Call ended');
    expect(bar.talkTime).toBe('01:05');
    expect(bar.moving).toBe(false);
    expect(bar.connected).toBe(false);
  });

  it('says nobody picked up rather than showing a zero', () => {
    expect(callBar(report({ state: 'ended', talkedSeconds: null }), call, PRESSED).phase).toBe('Not answered');
  });

  /*
    A report stamped before this call was pressed is about the last one. Reading
    it would show a finished call's clock over a call that is still ringing.
  */
  it('ignores a report about the previous call', () => {
    const stale = report({ state: 'ended', talkedSeconds: 300, reportedAt: PRESSED - 60_000 });
    expect(callBar(stale, call, PRESSED + 5_000).phase).toBeNull();
  });

  it('says so while the instruction is still on its way to the phone', () => {
    expect(callBar(null, { pressedAt: PRESSED, placing: true }, PRESSED).phase).toBe('Placing');
  });
});
