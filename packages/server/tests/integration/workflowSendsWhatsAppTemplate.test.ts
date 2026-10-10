/**
 * "A new lead arrives with status New, so the approved template goes to them."
 *
 * The step is only trustworthy if the whole path runs: the rule matches, the
 * template's blanks are filled from the record, and the message reaches the
 * provider. A stand-in server plays Meta, so what is checked is the request
 * that would have gone to a customer. Three promises, each one a way this CRM
 * has hurt itself before:
 *
 *  - a lead whose status is not New gets nothing;
 *  - the same person never gets the same template twice;
 *  - someone who opted out gets nothing, and it is not treated as a fault.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { invalidateWorkflows, runWorkflowsFor } from '../../src/core/workflow/engine.js';
import { createRecord } from '../../src/core/entity/recordService.js';
import { saveMapping } from '../../src/integrations/whatsapp/business/templates.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { adminContext, leadInput } from './fixtures.js';

const stamp = Date.now();
const TEMPLATE = `welcome_new_lead_${stamp}`;

let stub: Server;
const received: { path: string; body: Record<string, unknown> }[] = [];
let workflowId = '';
let templateId = '';
let wasActive = false;
const made: string[] = [];

async function newLead(overrides: Record<string, unknown> = {}): Promise<{ id: string; mobile: string; name: string }> {
  const ctx = await adminContext();
  const input = leadInput({ status: 'New', ...overrides });
  const rec = await createRecord(ctx, 'leads', input);
  made.push(rec.id as string);
  return { id: rec.id as string, mobile: String(input.mobile), name: String(input.full_name) };
}

/** What the engine receives when a lead is created. */
async function arrives(lead: { id: string; mobile: string; name: string }, status: string): Promise<void> {
  const ctx = await adminContext();
  await runWorkflowsFor('leads', ['on_create'], lead.id,
    { id: lead.id, full_name: lead.name, mobile: lead.mobile, status, owner_id: ctx.user.id },
    { user: null, source: 'test' });
}

beforeAll(async () => {
  await registry.warmup();

  stub = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('message_templates')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ name: TEMPLATE, language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}, thank you for your enquiry.' }] }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ messages: [{ id: `wamid.${received.length}` }] }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = (stub.address() as AddressInfo).port;

  const before = await db.queryOne<{ is_active: boolean }>(
    `SELECT is_active FROM ipy_integration WHERE provider = 'whatsapp_meta'`,
  );
  wasActive = Boolean(before?.is_active);
  await saveIntegration('whatsapp_meta', {
    config: { baseUrl: `http://127.0.0.1:${port}`, phoneNumberId: '555000111', wabaId: '555000222', apiVersion: 'v21.0' },
    credentials: { accessToken: 'test-token-not-real' },
    isActive: true,
  });
  await reloadIntegrations();

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_whatsapp_template (name, language, category, status, body_text)
     VALUES ($1, 'en', 'UTILITY', 'APPROVED', 'Hello {{1}}, thank you for your enquiry.')
     RETURNING id`,
    [TEMPLATE],
  );
  templateId = row!.id;
  await saveMapping(templateId, 'leads', { 1: 'field:full_name' });

  const mod = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
  const wf = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_workflow (module_id, name, trigger, execution_mode, is_active, sequence, conditions)
     VALUES ($1, 'welcome-new-lead-test', 'on_create', 'always', true, 9998, $2::jsonb)
     RETURNING id`,
    [mod!.id, JSON.stringify({ logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'New' }] })],
  );
  workflowId = wf!.id;
  await db.query(
    `INSERT INTO ipy_workflow_task (workflow_id, type, name, sequence, config)
     VALUES ($1, 'send_whatsapp_template', 'welcome', 1, $2::jsonb)`,
    [workflowId, JSON.stringify({ templateId })],
  );
  invalidateWorkflows();
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_workflow WHERE id = $1`, [workflowId]);
  await db.query(`DELETE FROM ipy_whatsapp_template WHERE id = $1`, [templateId]);
  await saveIntegration('whatsapp_meta', { config: { baseUrl: '', phoneNumberId: '' }, credentials: { accessToken: '' }, isActive: wasActive });
  await reloadIntegrations();
  invalidateWorkflows();
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe('a new lead with status New', () => {
  it('is sent the approved template, with its blank filled from the record', async () => {
    const lead = await newLead();
    const before = received.length;
    await arrives(lead, 'New');

    const sent = received.slice(before).filter((r) => r.path.endsWith('/messages'));
    expect(sent, 'exactly one message should leave').toHaveLength(1);
    const body = sent[0].body as {
      to: string; type: string;
      template: { name: string; components: { parameters: { text: string }[] }[] };
    };
    expect(body.type).toBe('template');
    expect(body.template.name).toBe(TEMPLATE);
    expect(body.template.components[0].parameters[0].text).toBe(lead.name);
    expect(body.to.endsWith(lead.mobile)).toBe(true);
  });

  it('is not sent the same template twice', async () => {
    const lead = await newLead();
    await arrives(lead, 'New');
    const afterFirst = received.length;
    await arrives(lead, 'New');
    expect(received.length, 'the second arrival must send nothing').toBe(afterFirst);
  });
});

describe('everybody else', () => {
  it('a lead whose status is not New is sent nothing', async () => {
    const lead = await newLead({ status: 'Contacted' });
    const before = received.length;
    await arrives(lead, 'Contacted');
    expect(received.length).toBe(before);
  });

  it('a person who opted out is sent nothing', async () => {
    const lead = await newLead();
    await db.query(
      `INSERT INTO ipy_channel_optout (handle, channel) VALUES ($1, 'whatsapp') ON CONFLICT DO NOTHING`,
      [lead.mobile],
    );
    const before = received.length;
    await arrives(lead, 'New');
    expect(received.length).toBe(before);
    await db.query(`DELETE FROM ipy_channel_optout WHERE handle = $1`, [lead.mobile]);
  });
});
