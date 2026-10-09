import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeFacebook } from '../src/integrations/leadsources/capture.js';
import { facebookGraph } from '../src/integrations/leadsources/facebook.js';

vi.mock('../src/core/settings/integrations.js', () => ({
  getSettings: () => ({ leadSources: { facebook: { pageAccessToken: 'test-page-token' } } }),
}));
afterEach(() => { vi.unstubAllGlobals(); });

describe('Facebook form lead recovery', () => {
  it('maps the actual budget choice and retains the site-visit answer and attribution', () => {
    const lead = normalizeFacebook({ id: 'lead-1', form_id: 'form-1', form_name: 'Sept. Lead Form',
      campaign_name: 'Greenfields campaign', field_data: [
        { name: 'full_name', values: ['A Buyer'] },
        { name: 'phone_number', values: ['+919811577100'] },
        { name: 'what_is_your_preferred_budget?', values: ['1.7_cr._to_2.0_cr.'] },
        { name: 'would_you_like_to_schedule_a_site_visit?', values: ['yes,_as_soon_as_possible'] },
      ] });
    expect(lead.budgetMax).toBe(20_000_000);
    expect(lead.mobile).toBe('+919811577100');
    expect(lead.externalId).toBe('lead-1');
    expect(lead.message).toContain('yes, as soon as possible');
    expect(lead.message).toContain('Sept. Lead Form');
    expect(lead.utm?.utm_campaign).toBe('Greenfields campaign');
  });

  it('keeps tokens out of URLs and rejects Graph errors instead of creating nameless leads', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400,
      json: async () => ({ error: { code: 190, message: 'Token expired' } }) });
    vi.stubGlobal('fetch', fetch);
    await expect(facebookGraph('123')).rejects.toThrow('Facebook 190: Token expired');
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).not.toContain('test-page-token');
    expect(options.headers.Authorization).toBe('Bearer test-page-token');
  });
});
