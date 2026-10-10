import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getRecord: vi.fn(), queryOne: vi.fn(), resolve: vi.fn(), send: vi.fn() }));
vi.mock('../../src/db/pool.js', () => ({ db: { queryOne: mocks.queryOne } }));
vi.mock('../../src/core/entity/recordService.js', () => ({ recordService: { getRecord: mocks.getRecord }, createRecord: vi.fn(), updateRecord: vi.fn() }));
vi.mock('../../src/core/metadata/registry.js', () => ({ registry: { requireModule: async () => ({ fields: [{ name: 'mobile', uitype: 'phone', isActive: true }] }) } }));
vi.mock('../../src/core/settings/timezone.js', () => ({ organisationTimezone: async () => 'Asia/Kolkata' }));
vi.mock('../../src/integrations/whatsapp/business/templates.js', () => ({ resolveTemplate: mocks.resolve, organisationName: async () => 'iPROPY' }));
vi.mock('../../src/integrations/whatsapp/business/send.js', () => ({ sendOnBusinessNumber: mocks.send }));
const { runTask, TASK_TYPES } = await import('../../src/core/workflow/tasks.js');
const context = { workflowId: 'wf', taskId: 'task', module: 'leads', recordId: 'record', record: {}, user: null, source: 'scheduler' };
const config = { deliveryVersion: 1, templateId: 'template', phoneField: 'mobile' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRecord.mockResolvedValue({ values: { mobile: '+919876543210', owner_id: 'owner', lead_status: 'Qualified' } });
  mocks.queryOne.mockImplementation(async (sql: string) => sql.includes('ipy_workflow')
    ? { is_active: true, conditions: { logic: 'AND', conditions: [{ field: 'lead_status', operator: 'equals', value: 'Qualified' }] } }
    : { id: 'owner', name: 'Assigned Agent' });
  mocks.resolve.mockResolvedValue({ name: 'ipropy_qualified_request_next_step', language: 'en', params: ['Client', 'record'], missing: [] });
  mocks.send.mockResolvedValue({ messageId: 'message' });
});
describe('WhatsApp workflow action', () => {
  it('is available in the workflow contract and sends mapped current record values', async () => {
    expect(TASK_TYPES).toContain('send_whatsapp');
    await runTask('send_whatsapp', config, context);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Assigned Agent', recordId: 'record' }));
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', to: '+919876543210', recordId: 'record' }));
  });
  it('does not resurrect historical actions', async () => {
    await expect(runTask('send_whatsapp', { template: 'old_birthday' }, context)).rejects.toThrow(/Configure/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('does not send after the status changes while waiting', async () => {
    mocks.getRecord.mockResolvedValue({ values: { lead_status: 'Lost' } });
    await runTask('send_whatsapp', config, context);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('does not send after the workflow is disabled', async () => {
    mocks.queryOne.mockResolvedValue({ is_active: false });
    await runTask('send_whatsapp', config, context);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('refuses an empty mobile and an invalid recipient field', async () => {
    await expect(runTask('send_whatsapp', { ...config, phoneField: 'email' }, context)).rejects.toThrow(/phone field/);
    mocks.getRecord.mockResolvedValue({ values: { lead_status: 'Qualified' } });
    await expect(runTask('send_whatsapp', config, context)).rejects.toThrow(/no mobile/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('refuses incomplete mappings without calling the provider', async () => {
    mocks.resolve.mockResolvedValue({ missing: [{ slot: '3', reason: 'Budget is empty' }] });
    await expect(runTask('send_whatsapp', config, context)).rejects.toThrow(/Budget is empty/);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('reports a send refusal as a workflow failure', async () => {
    mocks.send.mockRejectedValue(new Error('This person has opted out'));
    await expect(runTask('send_whatsapp', config, context)).rejects.toThrow(/opted out/);
  });
});
