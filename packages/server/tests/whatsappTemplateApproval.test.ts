import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.hoisted(() => vi.fn());
const provider = vi.hoisted(() => ({ current: null as null | { capabilities: Set<string>; listTemplates: typeof list } }));
vi.mock('../src/integrations/whatsapp/business/registry.js', () => ({ activeBusinessProvider: () => provider.current }));
const { assertApprovedTemplate } = await import('../src/integrations/whatsapp/business/templateApproval.js');
const input = { name: 'ipropy_new_enquiry_details', language: 'en', params: ['Client', 'ref-1'] };
beforeEach(() => {
  list.mockReset();
  provider.current = { capabilities: new Set(['templateSync']), listTemplates: list };
});
describe('live template approval gate', () => {
  it('accepts an approved, mapped template', async () => {
    list.mockResolvedValue([{ ...input, status: 'Approved', variableCount: 2 }]);
    await expect(assertApprovedTemplate(input)).resolves.toBeUndefined();
  });
  it.each(['SUBMITTED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN'])('blocks %s', async (status) => {
    list.mockResolvedValue([{ ...input, status, variableCount: 2 }]);
    await expect(assertApprovedTemplate(input)).rejects.toThrow(/not approved/);
  });
  it('blocks deleted templates and the wrong language', async () => {
    list.mockResolvedValue([{ ...input, language: 'hi', status: 'APPROVED', variableCount: 2 }]);
    await expect(assertApprovedTemplate(input)).rejects.toThrow(/missing/);
    list.mockResolvedValue([]);
    await expect(assertApprovedTemplate(input)).rejects.toThrow(/missing/);
  });
  it('blocks blanks and changed variable counts', async () => {
    list.mockResolvedValue([{ ...input, status: 'APPROVED', variableCount: 3 }]);
    await expect(assertApprovedTemplate(input)).rejects.toThrow(/wording has changed/);
    list.mockResolvedValue([{ ...input, status: 'APPROVED', variableCount: 2 }]);
    await expect(assertApprovedTemplate({ ...input, params: ['Client', ' '] })).rejects.toThrow(/variables/);
  });
  it('fails closed on a provider outage', async () => {
    list.mockRejectedValue(new Error('Provider unavailable'));
    await expect(assertApprovedTemplate(input)).rejects.toThrow(/unavailable/);
    provider.current = null;
    await expect(assertApprovedTemplate(input)).rejects.toThrow(/switched on/);
  });
});
