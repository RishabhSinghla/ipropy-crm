import { getSettings } from '../../core/settings/integrations.js';
import { captureLead, normalizeFacebook } from './capture.js';

export const FACEBOOK_GRAPH_VERSION = 'v26.0';
type FacebookLead = Parameters<typeof normalizeFacebook>[0];
interface PageResult<T> { data: T[]; paging?: { cursors?: { after?: string }; next?: string } }

/** Tokens stay in an Authorization header; neither errors nor reports contain them. */
export async function facebookGraph<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = getSettings().leadSources.facebook.pageAccessToken;
  if (!token) throw new Error('Save a Facebook Page access token first.');
  if (!/^[\dA-Za-z_/]+$/.test(path)) throw new Error('Invalid Facebook object.');
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json() as T & { error?: { message?: string; code?: number } };
  if (!response.ok || result.error) {
    throw new Error(`Facebook ${result.error?.code ?? response.status}: ${result.error?.message ?? 'Request failed'}`);
  }
  return result;
}

async function facebookPages<T>(path: string, fields: string): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await facebookGraph<PageResult<T>>(path, { fields, limit: '100', ...(after ? { after } : {}) });
    items.push(...result.data);
    if (!result.paging?.next) return items;
    const cursor = result.paging.cursors?.after;
    if (!cursor || cursor === after) throw new Error('Facebook pagination did not advance.');
    after = cursor;
  }
  throw new Error('Facebook returned more than 10,000 records; narrow the sync first.');
}

export async function testFacebookConnection(): Promise<{ ok: boolean; message: string }> {
  const page = await facebookGraph<{ id: string; name: string }>('me', { fields: 'id,name' });
  const forms = await facebookPages<{ id: string; name: string }>(`${page.id}/leadgen_forms`, 'id,name');
  return { ok: true, message: `Connected to ${page.name}; ${forms.length} lead forms are accessible.` };
}

let syncing = false;
export async function syncFacebookLeads() {
  if (syncing) throw new Error('Facebook sync is already running.');
  syncing = true;
  try {
    const page = await facebookGraph<{ id: string; name: string }>('me', { fields: 'id,name' });
    const forms = await facebookPages<{ id: string; name: string; leads_count?: number }>(
      `${page.id}/leadgen_forms`, 'id,name,leads_count',
    );
    const reports = [];
    for (const form of forms) {
      const report = { formId: form.id, formName: form.name, available: form.leads_count ?? 0,
        fetched: 0, created: 0, duplicate: 0, failed: 0, errors: [] as string[],
        campaigns: [] as string[], recordIds: [] as string[] };
      try {
        const leads = await facebookPages<FacebookLead>(`${form.id}/leads`,
          'id,created_time,field_data,form_id,ad_id,campaign_id,campaign_name');
        report.fetched = leads.length;
        for (const lead of leads) {
          const payload = { ...lead, form_id: form.id, form_name: form.name };
          const result = await captureLead('facebook', payload, normalizeFacebook(payload), { externalId: lead.id });
          report[result.status]++;
          if (result.recordId) report.recordIds.push(result.recordId);
          if (result.message && result.status === 'failed') report.errors.push(`${lead.id}: ${result.message}`);
          const campaign = lead.campaign_name ?? lead.campaign_id;
          if (campaign && !report.campaigns.includes(campaign)) report.campaigns.push(campaign);
        }
      } catch (err) { report.errors.push((err as Error).message); }
      reports.push(report);
    }
    return { pageId: page.id, pageName: page.name, forms: reports };
  } finally { syncing = false; }
}
