import { describe, expect, it } from 'vitest';
import { expiryWarning, facebookRetry, safeFacebookError } from '../src/integrations/leadsources/facebookRecovery.js';
import { facebookAssignmentInput } from '../src/integrations/leadsources/facebookAssignment.js';

describe('Facebook recovery safeguards', () => {
  it('backs off temporary failures, stops poison leads and retains access failures', () => {
    expect(facebookRetry(1, 'Network timeout')).toEqual({ dead: false, seconds: 60 });
    expect(facebookRetry(8, 'Network timeout').dead).toBe(true);
    expect(facebookRetry(100, 'Facebook 190: Token expired')).toEqual({ dead: false, seconds: 3600 });
    expect(facebookRetry(1, 'Mobile is required').dead).toBe(true);
    expect(facebookRetry(1, safeFacebookError(new Error('Mobile is required'))).dead).toBe(true);
  });

  it('warns before expiry without claiming a zero expiry is permanent', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(expiryWarning(0, now)).toBeNull();
    expect(expiryWarning((now + 31 * 86400000) / 1000, now)).toBeNull();
    expect(expiryWarning((now + 7 * 86400000) / 1000, now)).toContain('7 days');
    expect(expiryWarning((now - 1000) / 1000, now)).toContain('expired');
  });

  it('never echoes provider errors or customer answers into administrator alerts', () => {
    expect(safeFacebookError(new Error('Facebook 190: EAA-private-token'))).not.toContain('EAA');
    expect(safeFacebookError(new Error('Customer Secret +919999999999'))).not.toContain('9999');
  });

  it('requires one agent for single assignment and rejects duplicate agent selections', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(facebookAssignmentInput.safeParse({ strategy: 'specific_user', userIds: [a, b] }).success).toBe(false);
    expect(facebookAssignmentInput.safeParse({ strategy: 'round_robin', userIds: [a, a] }).success).toBe(false);
    expect(facebookAssignmentInput.safeParse({ strategy: 'round_robin', userIds: [] }).success).toBe(false);
    expect(facebookAssignmentInput.safeParse({ strategy: 'round_robin', userIds: [a, b] }).success).toBe(true);
  });
});
