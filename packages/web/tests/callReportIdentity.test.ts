import { describe, expect, it } from 'vitest';
import { callBar, deckStatus, reportMatchesCall, type PhoneCallReport } from '../src/lib/callConsole';

describe('phone reports belong to the number being called', () => {
  const call = { number: '+91 9818434034', pressedAt: 100_000, placing: false };
  const ended: PhoneCallReport = { number: '9818434034', state: 'ended', reportedAt: 110_000, connectedAt: 101_000, talkedSeconds: 9 };
  it('accepts a matching end report and stops the live animation', () => {
    expect(reportMatchesCall(ended, call)).toBe(true);
    expect(deckStatus(ended, call, 120_000).label).toContain('Call ended');
    expect(callBar(ended, call, 120_000).moving).toBe(false);
  });
  it('does not apply another number or an earlier call to this draft', () => {
    expect(reportMatchesCall({ ...ended, number: '9810594938' }, call)).toBe(false);
    expect(reportMatchesCall({ ...ended, reportedAt: 80_000 }, call)).toBe(false);
    expect(callBar({ ...ended, number: '9810594938' }, call, 120_000).phase).toBeNull();
  });
});
