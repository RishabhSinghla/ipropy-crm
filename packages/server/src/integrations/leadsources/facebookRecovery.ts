import { randomUUID } from 'node:crypto';
import { db, transaction } from '../../db/pool.js';
import { getSettings, getIntegrationConfig, warmup } from '../../core/settings/integrations.js';
import { notifyMany } from '../../core/notifications/index.js';
import { getModule } from '../../core/metadata/registry.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { captureLead, normalizeFacebook } from './capture.js';
import { facebookGraph, facebookPages, syncFacebookLeads, FACEBOOK_GRAPH_VERSION, observedFacebookVersion } from './facebook.js';

type Lead = Parameters<typeof normalizeFacebook>[0];
type Issues = Record<string, string>;
interface Health {
  last_reconciled_at: string | null;
  last_checked_at: string | null;
  token_expires_at: string | null;
  data_access_expires_at: string | null;
  graph_version: string | null;
  forms: { id: string; name: string; questions?: { key?: string; type?: string }[] }[];
  issues: Issues;
}

export function facebookRetry(attempt: number, message: string) {
  const accessProblem = /Facebook (190|10|200)\b|access token|permission/i.test(message);
  const invalidData = /is required|must be exactly|invalid (phone|mobile)|Lead data is invalid/i.test(message);
  return { dead: invalidData || (!accessProblem && attempt >= 8),
    seconds: accessProblem ? 3600 : Math.min(3600, 60 * 2 ** Math.min(attempt - 1, 6)) };
}

export function expiryWarning(timestamp: number | undefined, now = Date.now()): string | null {
  if (!timestamp) return null; // Meta uses 0 for no scheduled expiry, not proof of irrevocable access.
  const days = Math.ceil((timestamp * 1000 - now) / 86_400_000);
  if (days > 30) return null;
  return days <= 0 ? 'Facebook access has expired. Reauthorize the connection.'
    : `Facebook access expires in ${days} days. Renew it before leads stop arriving.`;
}

/** The entire signed batch is committed before Meta receives HTTP 200. */
export async function queueFacebookDeliveries(body: {
  entry?: { changes?: { field?: string; value?: { leadgen_id?: string; [key: string]: unknown } }[] }[];
}) {
  await transaction(async (tx) => {
    for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
      const id = change.value?.leadgen_id;
      if (change.field && change.field !== 'leadgen') continue;
      if (!id || !/^\d+$/.test(id)) continue;
      await tx.query(`INSERT INTO ipy_facebook_delivery (lead_id, payload) VALUES ($1, $2)
        ON CONFLICT (lead_id) DO NOTHING`, [id, JSON.stringify(change.value)]);
    }
  });
}

export async function retryFacebookFailures() {
  await db.query(`UPDATE ipy_facebook_delivery SET status = 'pending', attempts = 0,
    next_attempt_at = now(), error = NULL, lease_until = NULL WHERE status = 'dead' OR (status = 'pending' AND error IS NOT NULL)`);
  nudgeFacebookRecovery();
}

async function drainDeliveries() {
  for (let count = 0; count < 25; count++) {
    const job = await db.queryOne<{ lead_id: string; payload: Lead; attempts: number }>(
      `UPDATE ipy_facebook_delivery SET status = 'processing', attempts = attempts + 1,
         lease_until = now() + interval '10 minutes', updated_at = now()
       WHERE lead_id = (SELECT lead_id FROM ipy_facebook_delivery
         WHERE (status = 'pending' AND next_attempt_at <= now()) OR
           (status = 'processing' AND lease_until < now())
         ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING lead_id, payload, attempts`);
    if (!job) break;
    try {
      const detail = await facebookGraph<Lead>(job.lead_id, {
        fields: 'id,created_time,field_data,form_id,ad_id,campaign_id,campaign_name',
      });
      const payload = { ...job.payload, ...detail };
      const result = await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: job.lead_id });
      if (result.status === 'failed' || !result.recordId) throw new Error(result.message ?? 'Lead did not reach a CRM record.');
      await db.query(`UPDATE ipy_facebook_delivery SET status = 'done', error = NULL,
        lease_until = NULL, updated_at = now() WHERE lead_id = $1`, [job.lead_id]);
    } catch (err) {
      const message = safeFacebookError(err);
      const retry = facebookRetry(job.attempts, message);
      await db.query(`UPDATE ipy_facebook_delivery SET status = $2, error = $3, lease_until = NULL,
        next_attempt_at = now() + $4 * interval '1 second', updated_at = now() WHERE lead_id = $1`,
      [job.lead_id, retry.dead ? 'dead' : 'pending', message, retry.seconds]);
    }
  }
}

/** Provider errors must never echo a token, secret or lead answer into alerts. */
export function safeFacebookError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.match(/^Facebook (\d+):/)?.[1];
  if (code) return `Facebook ${code}: ${['190', '10', '200'].includes(code) ? 'Access or permissions need attention.' : 'Provider request failed; retry is scheduled.'}`;
  if (/access token/i.test(message)) return 'Save or renew the Facebook Page access token.';
  if (/No selected Facebook agent/.test(message)) return 'No selected Facebook agent is active and accepting leads.';
  if (/is required|must be exactly|invalid (phone|mobile)/i.test(message)) return 'Lead data is invalid or a required CRM field is missing. Review the Lead Inbox.';
  return 'Facebook sync could not complete. Check the integration and retry.';
}

async function tokenHealth() {
  const fb = getSettings().leadSources.facebook;
  if (!fb.appId || !fb.appSecret || !fb.pageAccessToken) throw new Error('Save a Facebook Page access token and app credentials.');
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/debug_token`);
  url.searchParams.set('input_token', fb.pageAccessToken);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${fb.appId}|${fb.appSecret}` }, signal: AbortSignal.timeout(20_000) });
  const result = await response.json() as { data?: { app_id?: string; is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] } };
  if (!response.ok || !result.data?.is_valid || result.data.app_id !== fb.appId) throw new Error('Facebook 190: Invalid token or wrong app.');
  return result.data;
}

async function checkAndReconcile() {
  const previous = await db.queryOne<Health>('SELECT * FROM ipy_facebook_health WHERE id = true');
  if (previous?.last_checked_at && Date.now() - Date.parse(previous.last_checked_at) < 15 * 60_000) return;
  const issues: Issues = {};
  let forms = previous?.forms ?? [];
  let tokenExpiry = previous?.token_expires_at ?? null;
  let dataExpiry = previous?.data_access_expires_at ?? null;
  try {
    const token = await tokenHealth();
    tokenExpiry = token.expires_at ? new Date(token.expires_at * 1000).toISOString() : null;
    dataExpiry = token.data_access_expires_at ? new Date(token.data_access_expires_at * 1000).toISOString() : null;
    const expiry = expiryWarning(token.expires_at) ?? expiryWarning(token.data_access_expires_at);
    if (expiry) issues.expiry = expiry;
    for (const scope of ['leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement']) {
      if (!token.scopes?.includes(scope)) issues.permissions = 'Facebook permissions have changed. Check lead and Page access.';
    }
  } catch (err) { issues.credentials = safeFacebookError(err); }
  try {
    const page = await facebookGraph<{ id: string }>('me', { fields: 'id' });
    forms = await facebookPages<Health['forms'][number]>(`${page.id}/leadgen_forms`, 'id,name,questions');
    if (previous?.forms.length && JSON.stringify(forms) !== JSON.stringify(previous.forms)) {
      issues.forms = 'Facebook forms or questions changed. Review mappings; raw answers are retained in the Lead Inbox.';
    }
    if (!forms.length) issues.forms = 'No Facebook lead forms are accessible. Check Page/form access.';
    try {
      const subscriptions = await facebookPages<{ id: string; subscribed_fields?: string[] }>(`${page.id}/subscribed_apps`, 'id,subscribed_fields');
      if (!subscriptions.some((app) => app.id === getSettings().leadSources.facebook.appId && app.subscribed_fields?.includes('leadgen'))) {
        issues.subscription = 'The Facebook Page is not subscribed to this app for leads. Reconciliation is the temporary fallback.';
      }
    } catch { issues.subscription = 'Could not verify Page webhook subscription. Check pages_manage_metadata; reconciliation continues.'; }
    const meta = await getModule('leads');
    const source = meta?.fields.find((f) => ['source', 'lead_source'].includes(f.name) && f.isActive);
    if (!source?.options?.some((o) => [o.value, o.label].some((v) => /^facebook(?: lead ads?)?$/i.test(v.trim())))) {
      issues.mapping = 'The CRM Facebook Source option is missing. Restore it or review mappings.';
    }
    // A day's overlap catches delayed Meta indexing. Never advance on a failed form.
    const since = previous?.last_reconciled_at ? Date.parse(previous.last_reconciled_at) - 86_400_000 : Date.now() - 90 * 86_400_000;
    const started = new Date().toISOString();
    const result = await syncFacebookLeads({ since: Math.floor(since / 1000), automatic: true });
    for (const form of result.forms) {
      if (form.failed || form.errors.length) issues.sync = 'Some Facebook leads need review or retry. Open the Lead Inbox.';
      await db.query(`INSERT INTO ipy_facebook_delivery (lead_id, payload)
        SELECT external_id, raw_payload FROM ipy_lead_inbox WHERE source = 'facebook'
          AND status IN ('failed', 'pending') AND raw_payload->>'form_id' = $1
          AND external_id ~ '^[0-9]+$' ON CONFLICT DO NOTHING`, [form.formId]);
    }
    if (result.forms.every((form) => !form.errors.length)) {
      await db.query('UPDATE ipy_facebook_health SET last_reconciled_at = $1 WHERE id = true', [started]);
    }
  } catch (err) { issues.sync = safeFacebookError(err); }
  if (observedFacebookVersion && observedFacebookVersion !== FACEBOOK_GRAPH_VERSION) {
    issues.version = 'Meta served a different API version. Review compatibility before changing versions.';
  }
  await db.query(`UPDATE ipy_facebook_health SET last_checked_at = now(), token_expires_at = $1,
    data_access_expires_at = $2, forms = $3, issues = $4, graph_version = $5 WHERE id = true`,
  [tokenExpiry, dataExpiry, JSON.stringify(forms), JSON.stringify(issues), observedFacebookVersion ?? FACEBOOK_GRAPH_VERSION]);
}

async function sendAlerts() {
  const health = await db.queryOne<Health>('SELECT * FROM ipy_facebook_health WHERE id = true');
  const issues = { ...health?.issues };
  const failed = await db.queryOne<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ipy_facebook_delivery
    WHERE status = 'dead' OR (status <> 'done' AND created_at < now() - interval '30 minutes')`);
  if (failed?.count) issues.deliveries = `${failed.count} Facebook deliveries need attention. Review the inbox or Retry failed deliveries.`;
  const agents = await db.queryOne<{ invalid: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM ipy_facebook_health h JOIN ipy_assignment_rule ar ON ar.id = h.assignment_rule_id
    CROSS JOIN LATERAL jsonb_array_elements_text(ar.target_users) selected(id)
    LEFT JOIN ipy_user u ON u.id = selected.id::uuid
    WHERE NOT COALESCE(u.is_active AND u.accepts_leads AND u.deleted_at IS NULL, false)) AS invalid`);
  if (agents?.invalid) issues.assignment = 'A selected Facebook agent is inactive or no longer accepts leads. Review the assignment master.';
  await db.query(`UPDATE ipy_facebook_alert SET resolved_at = now()
    WHERE resolved_at IS NULL AND NOT (key = ANY($1::text[]))`, [Object.keys(issues)]);
  for (const [key, message] of Object.entries(issues)) {
    const alert = await db.queryOne<{ key: string }>(`INSERT INTO ipy_facebook_alert (key, message, last_notified_at)
      VALUES ($1, $2, NULL) ON CONFLICT (key) DO UPDATE SET message = EXCLUDED.message,
        last_notified_at = NULL, resolved_at = NULL
      WHERE ipy_facebook_alert.resolved_at IS NOT NULL OR ipy_facebook_alert.message <> EXCLUDED.message
        OR ipy_facebook_alert.last_notified_at IS NULL
        OR ipy_facebook_alert.last_notified_at < now() - interval '24 hours' RETURNING key`, [key, message]);
    if (alert) {
      const admins = await db.query<{ id: string }>('SELECT id FROM ipy_user WHERE is_admin AND is_active AND deleted_at IS NULL');
      await notifyMany(admins.rows.map((u) => u.id), { kind: 'facebook_integration', title: 'Facebook lead sync needs attention',
        body: message, link: '/admin/integrations' });
      await db.query('UPDATE ipy_facebook_alert SET last_notified_at = now() WHERE key = $1', [key]);
    }
  }
}

let running = false;
let nudge: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
export function nudgeFacebookRecovery() {
  if (!config.scheduler.enabled || nudge) return;
  nudge = setTimeout(() => { nudge = null; void runFacebookRecovery(); }, 250);
  nudge.unref?.();
}

export async function runFacebookRecovery() {
  if (running) return;
  running = true;
  const workerId = randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let locked = false;
  let enabled = false;
  try {
    locked = Boolean(await db.queryOne(`UPDATE ipy_facebook_health
      SET worker_id = $1, worker_lease_until = now() + interval '10 minutes'
      WHERE id = true AND (worker_lease_until IS NULL OR worker_lease_until < now())
      RETURNING id`, [workerId]));
    if (!locked) return;
    heartbeat = setInterval(() => {
      void db.query(`UPDATE ipy_facebook_health SET worker_lease_until = now() + interval '10 minutes'
        WHERE id = true AND worker_id = $1`, [workerId]).catch(() => {
          logger.error('Facebook recovery lease renewal failed.');
        });
    }, 30_000);
    heartbeat.unref?.();
    await warmup(); // A second worker must see credential changes without restarting.
    enabled = Boolean(getIntegrationConfig('facebook_leads'));
    if (!enabled) return;
    await drainDeliveries();
    await checkAndReconcile();
    await sendAlerts();
  } catch { logger.error('Facebook recovery could not complete; durable deliveries will retry on the next tick.'); }
  finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked) await db.query(`UPDATE ipy_facebook_health SET worker_id = NULL, worker_lease_until = NULL
      WHERE id = true AND worker_id = $1`, [workerId]).catch(() => {
        logger.error('Facebook recovery lease release failed; it will expire automatically.');
      });
    running = false;
    // Continue large batches and honour due retries without polling an idle DB.
    // The scheduler remains the restart/second-instance safety net.
    if (locked && enabled && config.scheduler.enabled) {
      const next = await db.queryOne<{ seconds: number }>(`SELECT GREATEST(0, EXTRACT(EPOCH FROM MIN(
        CASE WHEN status = 'processing' THEN lease_until ELSE next_attempt_at END) - now())) AS seconds
        FROM ipy_facebook_delivery WHERE status IN ('pending', 'processing')`).catch(() => null);
      if (next?.seconds != null) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; void runFacebookRecovery(); },
          Math.max(250, Number(next.seconds) * 1000));
        retryTimer.unref?.();
      }
    }
  }
}

export async function getFacebookHealth() {
  const health = await db.queryOne<Health>('SELECT * FROM ipy_facebook_health WHERE id = true');
  const queue = await db.query<{ status: string; count: number }>('SELECT status, COUNT(*)::int AS count FROM ipy_facebook_delivery GROUP BY status');
  const alerts = await db.query<{ key: string; message: string }>('SELECT key, message FROM ipy_facebook_alert WHERE resolved_at IS NULL ORDER BY key');
  return { ...health, queue: queue.rows, alerts: alerts.rows };
}
