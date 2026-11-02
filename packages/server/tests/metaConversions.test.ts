import { describe, expect, it } from 'vitest';
import { buildConversionBody, hashed, isWantedStage, wantedStages } from '../src/integrations/leadsources/metaConversions';

describe('which stages are told to Meta', () => {
  it('uses Qualified, Site Visit Done and Converted when the box is empty', () => {
    expect(wantedStages('')).toEqual(['qualified', 'site visit done', 'converted']);
    expect(wantedStages(undefined)).toEqual(['qualified', 'site visit done', 'converted']);
  });

  it('reads the owner\'s own list, ignoring case, spaces and stray commas', () => {
    expect(wantedStages(' Qualified ,, Booked ')).toEqual(['qualified', 'booked']);
  });

  it('matches a status by its stored value or by its label, and nothing else', () => {
    const stages = wantedStages('Site Visit Done');
    expect(isWantedStage(stages, 'Site Visit Done', 'Site Visit Done')).toBe(true);
    expect(isWantedStage(stages, 'site_visit_done', 'site visit done')).toBe(true);
    expect(isWantedStage(stages, 'Contacted', 'Contacted')).toBe(false);
    expect(isWantedStage(stages, 'Lost', 'Lost')).toBe(false);
  });
});

describe('what is sent to Meta', () => {
  const base = { eventName: 'Qualified', recordId: 'r1', leadId: '123456789012345678', nowSeconds: 1_760_000_000 };

  it('hashes the way Meta asks: trimmed, lower case, SHA-256 hex', () => {
    expect(hashed('  A@B.com ')).toBe(hashed('a@b.com'));
    expect(hashed('a@b.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the lead id as text, a hashed phone and email, and says it came from the CRM', () => {
    const body = buildConversionBody({ ...base, countryCode: '+91', mobile: '98765 43210', email: 'Buyer@Example.com' });
    const event = (body.data as Record<string, unknown>[])[0]!;
    expect(event).toMatchObject({
      event_name: 'Qualified',
      event_time: 1_760_000_000,
      event_id: 'r1:Qualified',
      action_source: 'system_generated',
      custom_data: { event_source: 'crm', lead_event_source: 'iPropy CRM' },
    });
    const user = event.user_data as Record<string, unknown>;
    expect(user.lead_id).toBe('123456789012345678');
    expect(user.ph).toEqual([hashed('919876543210')]);
    expect(user.em).toEqual([hashed('buyer@example.com')]);
  });

  it('never puts the plain phone number or email anywhere in the body', () => {
    const text = JSON.stringify(buildConversionBody({ ...base, countryCode: '91', mobile: '9876543210', email: 'buyer@example.com' }));
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('buyer@example.com');
  });

  it('still reports a lead that has no phone or email', () => {
    const body = buildConversionBody(base);
    const user = ((body.data as Record<string, unknown>[])[0]!).user_data as Record<string, unknown>;
    expect(user).toEqual({ lead_id: '123456789012345678' });
  });

  it('adds the test code only when there is one', () => {
    expect(buildConversionBody(base)).not.toHaveProperty('test_event_code');
    expect(buildConversionBody({ ...base, testEventCode: 'TEST1' })).toMatchObject({ test_event_code: 'TEST1' });
  });
});
