import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { createApp } from '../../src/app.js';
import { captureLead, normalizeFacebook } from '../../src/integrations/leadsources/capture.js';
import { queueFacebookDeliveries, runFacebookRecovery, retryFacebookFailures } from '../../src/integrations/leadsources/facebookRecovery.js';
import { saveFacebookAssignment } from '../../src/integrations/leadsources/facebookAssignment.js';
import { assignOwner } from '../../src/core/workflow/assignment.js';
import { adminContext, authUser, SEEDED } from './fixtures.js';

vi.mock('../../src/core/settings/integrations.js', async (original) => ({
  ...await original<typeof import('../../src/core/settings/integrations.js')>(),
  getSettings: () => ({ leadSources: { facebook: { appId: '195', appSecret: 'test-signing-secret', pageAccessToken: 'test-token' } } }),
  getIntegrationConfig: () => ({}), warmup: async () => {},
}));
const graph = vi.hoisted(() => vi.fn());
const pages = vi.hoisted(() => vi.fn());
const sync = vi.hoisted(() => vi.fn());
vi.mock('../../src/integrations/leadsources/facebook.js', async (original) => ({
  ...await original<typeof import('../../src/integrations/leadsources/facebook.js')>(),
  facebookGraph: graph, facebookPages: pages, syncFacebookLeads: sync,
}));

const made: string[] = [];
let previousHealth: Record<string, unknown>;
const ids = ['900195000001', '900195000002', '900195000003'];
const lead = (id: string, phone = '+919811577191') => ({ id, form_id: '195',
  field_data: [{ name: 'full_name', values: ['Recovery test'] }, { name: 'phone_number', values: [phone] }],
  form_name: 'Recovery test form',
});

beforeAll(async () => {
  await registry.warmup();
  previousHealth = (await db.queryOne('SELECT * FROM ipy_facebook_health WHERE id = true'))!;
  // Test delivery separately from the provider-facing health check.
  await db.query('UPDATE ipy_facebook_health SET last_checked_at = now() WHERE id = true');
});
afterAll(async () => {
  const rule = await db.queryOne<{ assignment_rule_id: string | null }>('SELECT assignment_rule_id FROM ipy_facebook_health WHERE id = true');
  await db.query(`UPDATE ipy_facebook_health SET assignment_rule_id = $1, last_checked_at = $2,
    last_reconciled_at = $3, issues = $4, forms = $5, token_expires_at = $6,
    data_access_expires_at = $7, graph_version = $8 WHERE id = true`,
    [previousHealth.assignment_rule_id, previousHealth.last_checked_at, previousHealth.last_reconciled_at,
      JSON.stringify(previousHealth.issues), JSON.stringify(previousHealth.forms), previousHealth.token_expires_at,
      previousHealth.data_access_expires_at, previousHealth.graph_version]);
  if (rule?.assignment_rule_id && rule.assignment_rule_id !== previousHealth.assignment_rule_id) await db.query('DELETE FROM ipy_assignment_rule WHERE id = $1', [rule.assignment_rule_id]);
  if (made.length) await db.query('DELETE FROM ipy_record WHERE id = ANY($1::uuid[])', [made]);
  await db.query('DELETE FROM ipy_lead_inbox WHERE external_id = ANY($1::text[])', [ids]);
  await db.query('DELETE FROM ipy_facebook_delivery WHERE lead_id = ANY($1::text[])', [ids]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('durable Facebook delivery and assignment', () => {
  it('respects a live worker lease and recovers an expired lease through pooled connections', async () => {
    await db.query(`UPDATE ipy_facebook_health SET worker_id = gen_random_uuid(),
      worker_lease_until = now() + interval '10 minutes' WHERE id = true`);
    await runFacebookRecovery();
    expect((await db.queryOne<{ worker_id: string }>('SELECT worker_id FROM ipy_facebook_health'))?.worker_id).toBeTruthy();
    await db.query("UPDATE ipy_facebook_health SET worker_lease_until = now() - interval '1 minute' WHERE id = true");
    await runFacebookRecovery();
    expect((await db.queryOne<{ worker_id: string | null }>('SELECT worker_id FROM ipy_facebook_health'))?.worker_id).toBeNull();
  });
  it('stores a signed delivery before acknowledgement and deduplicates a replay', async () => {
    const app = createApp();
    const body = { entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: ids[0] } }] }] };
    const raw = JSON.stringify(body);
    const signature = `sha256=${createHmac('sha256', 'test-signing-secret').update(raw).digest('hex')}`;
    await request(app).post('/api/webhooks/leads/facebook').set('Content-Type', 'application/json').set('x-hub-signature-256', signature).send(raw).expect(200);
    await queueFacebookDeliveries(body);
    expect((await db.queryOne<{ count: number }>('SELECT COUNT(*)::int AS count FROM ipy_facebook_delivery WHERE lead_id = $1', [ids[0]]))?.count).toBe(1);
    await request(app).post('/api/webhooks/leads/facebook').send(body).expect(401);
  });

  it('retains a token failure, then recovers the same delivery with one contact and one note', async () => {
    graph.mockRejectedValueOnce(new Error('Facebook 190: Expired token'));
    await runFacebookRecovery();
    expect((await db.queryOne<{ status: string }>('SELECT status FROM ipy_facebook_delivery WHERE lead_id = $1', [ids[0]]))?.status).toBe('pending');
    graph.mockResolvedValue(lead(ids[0]));
    await retryFacebookFailures();
    await runFacebookRecovery();
    const inbox = await db.queryOne<{ record_id: string; status: string }>('SELECT record_id, status FROM ipy_lead_inbox WHERE external_id = $1', [ids[0]]);
    expect(inbox?.status).toBe('processed');
    made.push(inbox!.record_id);
    // Simulate a crash after record/note save but before marking the inbox complete.
    await db.query("UPDATE ipy_lead_inbox SET status = 'pending' WHERE external_id = $1", [ids[0]]);
    const payload = lead(ids[0]);
    const recovered = await captureLead('facebook', payload, normalizeFacebook(payload));
    expect(recovered.recordId).toBe(inbox!.record_id);
    expect((await db.queryOne<{ count: number }>('SELECT COUNT(*)::int AS count FROM ipy_comment WHERE facebook_lead_id = $1', [ids[0]]))?.count).toBe(1);
  });

  it('reclaims an expired worker lease and quarantines invalid lead data', async () => {
    await queueFacebookDeliveries({ entry: [{ changes: [{ value: { leadgen_id: ids[1] } }] }] });
    await db.query("UPDATE ipy_facebook_delivery SET status = 'processing', lease_until = now() - interval '1 minute' WHERE lead_id = $1", [ids[1]]);
    graph.mockResolvedValue(lead(ids[1], '<test lead: dummy data>'));
    await runFacebookRecovery();
    const job = await db.queryOne<{ status: string; error: string }>('SELECT status, error FROM ipy_facebook_delivery WHERE lead_id = $1', [ids[1]]);
    expect(job?.status).toBe('dead');
    expect(job?.error).not.toContain('dummy data');
  });

  it('persists single-agent and fair round-robin choices, and refuses inactive agents', async () => {
    const admin = await adminContext();
    const a = await authUser(SEEDED.executiveA);
    const b = await authUser(SEEDED.executiveB);
    await db.query('UPDATE ipy_user SET accepts_leads = true WHERE id = ANY($1::uuid[])', [[a.id, b.id]]);
    const single = await saveFacebookAssignment({ strategy: 'specific_user', userIds: [a.id] }, admin.user.id);
    const source = (await registry.requireModule('leads')).fields.find((field) => ['source', 'lead_source'].includes(field.name))!;
    const facebook = source.options!.find((option) => /facebook/i.test(option.label))!;
    const values = { [source.name]: facebook.value };
    expect(await assignOwner('leads', values, { ruleId: single!.id })).toBe(a.id);
    const rotation = await saveFacebookAssignment({ strategy: 'round_robin', userIds: [a.id, b.id] }, admin.user.id);
    const chosen = await Promise.all(Array.from({ length: 6 }, () => assignOwner('leads', values, { ruleId: rotation!.id })));
    expect(chosen.filter((id) => id === a.id)).toHaveLength(3);
    expect(chosen.filter((id) => id === b.id)).toHaveLength(3);
    await db.query('UPDATE ipy_user SET is_active = false WHERE id = $1', [b.id]);
    try { await expect(saveFacebookAssignment({ strategy: 'specific_user', userIds: [b.id] }, admin.user.id)).rejects.toThrow('active'); }
    finally { await db.query('UPDATE ipy_user SET is_active = true WHERE id = $1', [b.id]); }
  });

  it('alerts on expiry, lost permissions and changed questions without advancing a failed reconciliation', async () => {
    await db.query(`UPDATE ipy_facebook_health SET last_checked_at = NULL,
      last_reconciled_at = '2026-10-01T00:00:00Z', forms = '[{"id":"195","name":"Original"}]' WHERE id = true`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {
      is_valid: true, app_id: '195', expires_at: Math.floor(Date.now() / 1000) + 7 * 86400,
      scopes: ['leads_retrieval'],
    } }) }));
    graph.mockResolvedValue({ id: '195' });
    pages.mockImplementation(async (path: string) => path.endsWith('leadgen_forms')
      ? [{ id: '195', name: 'Changed', questions: [{ key: 'new_question', type: 'CUSTOM' }] }]
      : []);
    sync.mockResolvedValue({ forms: [{ formId: '195', failed: 1, errors: ['Provider request failed'] }] });
    await runFacebookRecovery();
    const health = await db.queryOne<{ issues: Record<string, string>; last_reconciled_at: Date }>(
      'SELECT issues, last_reconciled_at FROM ipy_facebook_health WHERE id = true');
    expect(Object.keys(health!.issues)).toEqual(expect.arrayContaining(['expiry', 'permissions', 'forms', 'subscription', 'sync']));
    expect(new Date(health!.last_reconciled_at).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(sync).toHaveBeenCalledWith({ automatic: true, since: Date.parse('2026-09-30T00:00:00Z') / 1000 });
    const alerts = await db.query<{ key: string; last_notified_at: Date }>(
      "SELECT key, last_notified_at FROM ipy_facebook_alert WHERE key = ANY($1::text[])", [['expiry', 'permissions', 'forms', 'subscription', 'sync']]);
    expect(alerts.rows).toHaveLength(5);
    expect(alerts.rows.every((alert) => alert.last_notified_at != null)).toBe(true);
  });
});
