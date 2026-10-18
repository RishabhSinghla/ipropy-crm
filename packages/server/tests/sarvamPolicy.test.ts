import { describe, expect, it } from 'vitest';
import { sarvamCallingAllowed, sarvamPolicySchema } from '../src/integrations/voiceagent/policy.js';
const policy = sarvamPolicySchema.parse({});
describe('AI outbound calling window in India', () => {
  it('includes 10 AM, excludes 7 PM, and is independent of the server timezone', () => {
    expect(sarvamCallingAllowed(policy,new Date('2026-10-18T04:29:59Z'))).toBe(false);
    expect(sarvamCallingAllowed(policy,new Date('2026-10-18T04:30:00Z'))).toBe(true);
    expect(sarvamCallingAllowed(policy,new Date('2026-10-18T13:29:59Z'))).toBe(true);
    expect(sarvamCallingAllowed(policy,new Date('2026-10-18T13:30:00Z'))).toBe(false);
  });
  it('supports an explicit overnight window', () => {
    const overnight = { ...policy,callStart:'22:00',callEnd:'07:00' };
    expect(sarvamCallingAllowed(overnight,new Date('2026-10-18T17:00:00Z'))).toBe(true);
    expect(sarvamCallingAllowed(overnight,new Date('2026-10-18T23:00:00Z'))).toBe(true);
    expect(sarvamCallingAllowed(overnight,new Date('2026-10-19T01:30:00Z'))).toBe(false);
  });
  it('requires valid bounded batches and unambiguous time settings', () => {
    for (const bad of [{batchSize:0},{batchSize:201},{batchSize:2.5},{callStart:'25:00'},{callStart:'10:00',callEnd:'10:00'}]) expect(sarvamPolicySchema.safeParse(bad).success).toBe(false);
    expect(sarvamCallingAllowed({...policy,callingHoursEnabled:'false'},new Date('2026-10-18T23:00:00Z'))).toBe(true);
  });
});
