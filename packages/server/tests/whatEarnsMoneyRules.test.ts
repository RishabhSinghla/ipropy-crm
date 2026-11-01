import { describe, expect, it } from 'vitest';
import { failureReason, templateCategory } from '../src/core/analytics/roi.js';

describe('what earns money — small rules', () => {
  it('reads the template type from Meta first, then the name', () => {
    expect(templateCategory('x_mkt', 'UTILITY')).toBe('utility');
    expect(templateCategory('ipropy_new_enquiry_details_mkt', 'general')).toBe('marketing');
    expect(templateCategory('ipropy_won_handover_support_utl', null)).toBe('utility');
    expect(templateCategory('thankyou', 'general')).toBe('unknown');
  });
  it('groups failures by Meta code', () => {
    expect(failureReason('blah (Error Code : 131049 ) blah')).toContain('131049');
    expect(failureReason(null)).toBe('No reason given');
  });
});
