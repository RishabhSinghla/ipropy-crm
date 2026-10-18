import { z } from 'zod';
import { getIntegrationConfig } from '../../core/settings/integrations.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time in HH:MM format.');
export const sarvamPolicySchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(200).default(25),
  callStart: time.default('10:00'),
  callEnd: time.default('19:00'),
  callingHoursEnabled: z.enum(['true', 'false']).default('true'),
  inboundDeploymentId: z.string().max(200).default(''),
  inboundModule: z.string().min(1).max(100).default('leads'),
  syncInboundVersion: z.enum(['true', 'false']).default('false'),
}).refine((value) => value.callingHoursEnabled === 'false' || value.callStart !== value.callEnd, {
  message: 'Start and end must differ. Disable the calling window for unrestricted hours.', path: ['callEnd'],
});
export type SarvamPolicy = z.infer<typeof sarvamPolicySchema>;
export function readSarvamPolicy(): SarvamPolicy {
  return sarvamPolicySchema.parse(getIntegrationConfig('sarvam_voice') ?? {});
}
export function sarvamCallingAllowed(policy: Pick<SarvamPolicy, 'callingHoursEnabled' | 'callStart' | 'callEnd'>, now = new Date()): boolean {
  if (policy.callingHoursEnabled === 'false') return true;
  const current = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return policy.callStart < policy.callEnd
    ? current >= policy.callStart && current < policy.callEnd
    : current >= policy.callStart || current < policy.callEnd;
}
export function publicSarvamPolicy() {
  const policy = readSarvamPolicy();
  return { batchSize: policy.batchSize, start: policy.callStart, end: policy.callEnd,
    enabled: policy.callingHoursEnabled === 'true', timezone: 'Asia/Kolkata', callingAllowed: sarvamCallingAllowed(policy) };
}
