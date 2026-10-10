/** Real workflow/record/mapping/message tables; only the external provider is mocked. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const provider = vi.hoisted(() => ({
  name: 'test-provider', capabilities: new Set(['templates', 'templateSync']),
  listTemplates: vi.fn(), sendTemplate: vi.fn(),
}));
vi.mock('../../src/integrations/whatsapp/business/registry.js', () => ({ activeBusinessProvider: () => provider }));
import { db } from '../../src/db/pool.js';
import { createRecord } from '../../src/core/entity/recordService.js';
import { invalidateWorkflows, runWorkflowsFor } from '../../src/core/workflow/engine.js';
import { saveMapping } from '../../src/integrations/whatsapp/business/templates.js';
import { adminContext, leadInput } from './fixtures.js';

const name = `workflow_whatsapp_${Date.now()}`;
let templateId: string;
let workflowId: string;
let ctx: Awaited<ReturnType<typeof adminContext>>;
const recordIds: string[] = [];
beforeAll(async () => {
  ctx = await adminContext();
  templateId = (await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_whatsapp_template (name, language, category, status, body_text)
     VALUES ($1, 'en', 'UTILITY', 'APPROVED', 'Hello {{1}}, enquiry {{2}}') RETURNING id`, [name],
  ))!.id;
  await saveMapping(templateId, 'leads', { 1: 'field:full_name', 2: 'record:id' });
  workflowId = (await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_workflow (module_id, name, trigger, watch_fields, conditions, execution_mode, is_active)
     SELECT id, $1, 'on_field_change', '["status"]'::jsonb, $2::jsonb, 'once', true
     FROM ipy_module WHERE name = 'leads' RETURNING id`,
    [name, JSON.stringify({ logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'New' }] })],
  ))!.id;
  await db.query(`INSERT INTO ipy_workflow_task (workflow_id, type, name, config)
    VALUES ($1, 'send_whatsapp', 'WhatsApp integration test', $2::jsonb)`,
  [workflowId, JSON.stringify({ deliveryVersion: 1, templateId, phoneField: 'mobile' })]);
  invalidateWorkflows();
});
beforeEach(() => {
  vi.clearAllMocks();
  provider.listTemplates.mockResolvedValue([{ name, language: 'en', status: 'APPROVED', variableCount: 2 }]);
  provider.sendTemplate.mockResolvedValue({ providerMessageId: `test-${Date.now()}`, status: 'sent' });
});
afterAll(async () => {
  await db.query('DELETE FROM ipy_workflow WHERE id = $1', [workflowId]);
  await db.query('DELETE FROM ipy_message WHERE conversation_id IN (SELECT id FROM ipy_conversation WHERE record_id = ANY($1::uuid[]))', [recordIds]);
  await db.query('DELETE FROM ipy_conversation WHERE record_id = ANY($1::uuid[])', [recordIds]);
  await db.query('DELETE FROM ipy_record WHERE id = ANY($1::uuid[])', [recordIds]);
  await db.query('DELETE FROM ipy_whatsapp_template WHERE id = $1', [templateId]);
  invalidateWorkflows();
});
async function lead() {
  const r = await createRecord(ctx, 'leads', leadInput({ full_name: 'Workflow WhatsApp Client', status: 'New', owner_id: ctx.user.id }));
  recordIds.push(r.id);
  return r;
}
async function run(r: Awaited<ReturnType<typeof lead>>, changedFields = ['status']) {
  await runWorkflowsFor('leads', ['on_field_change'], r.id, r.values,
    { user: ctx.user, source: 'integration-test', changedFields });
}
describe('status workflow to WhatsApp delivery log', () => {
  it('sends one personalised message and records it, without re-sending on unrelated edits', async () => {
    const r = await lead();
    await run(r);
    expect(provider.sendTemplate).toHaveBeenCalledOnce();
    expect(provider.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ params: ['Workflow WhatsApp Client', r.id] }));
    expect((await db.queryOne<{ status: string }>('SELECT m.status FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id WHERE c.record_id = $1', [r.id]))?.status).toBe('sent');
    await run(r, ['email']);
    await run(r);
    expect(provider.sendTemplate).toHaveBeenCalledOnce();
  });
  it('does not send for pending approval; records the reason in workflow logs', async () => {
    provider.listTemplates.mockResolvedValue([{ name, language: 'en', status: 'SUBMITTED', variableCount: 2 }]);
    const r = await lead();
    await run(r);
    expect(provider.sendTemplate).not.toHaveBeenCalled();
    const log = await db.queryOne<{ error: string }>('SELECT error FROM ipy_workflow_log WHERE workflow_id = $1 AND record_id = $2', [workflowId, r.id]);
    expect(log?.error).toMatch(/not approved/);
  });
  it('records an external refusal as failed, not sent', async () => {
    provider.sendTemplate.mockRejectedValue(new Error('Provider refused this message'));
    const r = await lead();
    await run(r);
    expect((await db.queryOne<{ status: string }>('SELECT m.status FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id WHERE c.record_id = $1', [r.id]))?.status).toBe('failed');
  });
});
