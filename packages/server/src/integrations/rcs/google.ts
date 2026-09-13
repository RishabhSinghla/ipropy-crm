/** Google RCS for Business (RBM) provider.
 *
 * Google requires an approved RBM agent and a service-account key; this is
 * deliberately not a fake "RCS" switch that silently sends SMS instead.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getSettings } from '../../core/settings/integrations.js';

interface ServiceAccount { client_email?: string; private_key?: string }

function credentials(): { agentId: string; region: string; account: Required<ServiceAccount> } | null {
  const rcs = getSettings().rcs;
  if (!rcs.active || !rcs.agentId || !rcs.serviceAccountJson) return null;
  try {
    const account = JSON.parse(rcs.serviceAccountJson) as ServiceAccount;
    if (!account.client_email || !account.private_key) return null;
    return { agentId: rcs.agentId, region: rcs.region || 'us', account: account as Required<ServiceAccount> };
  } catch { return null; }
}

async function token(account: Required<ServiceAccount>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/rcsbusinessmessaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }, account.private_key, { algorithm: 'RS256' });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(body.error_description ?? `Google OAuth returned HTTP ${response.status}`);
  return body.access_token;
}

export async function testGoogleRcs(): Promise<{ ok: boolean; message: string }> {
  const c = credentials();
  if (!c) return { ok: false, message: 'Agent ID and a valid service-account JSON key are required.' };
  await token(c.account);
  return { ok: true, message: 'Google authenticated this RCS agent. Send a test message to an invited RCS device before launch.' };
}

export async function sendText(to: string, text: string, trafficType: 'PROMOTION' | 'TRANSACTION' | 'AUTHENTICATION' = 'TRANSACTION'): Promise<{ providerMessageId: string }> {
  const c = credentials();
  if (!c) throw new Error('Google RCS is not connected. Add an Agent ID and service-account JSON in Integrations.');
  const accessToken = await token(c.account);
  const messageId = crypto.randomUUID();
  const region = c.region.replace(/[^a-z0-9-]/gi, '');
  const url = `https://${region}-rcsbusinessmessaging.googleapis.com/v1/phones/${encodeURIComponent(to)}/agentMessages?messageId=${encodeURIComponent(messageId)}&agentId=${encodeURIComponent(c.agentId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': 'iPropy-CRM/RCS' },
    body: JSON.stringify({ contentMessage: { text }, messageTrafficType: trafficType }), signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as { name?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `Google RCS returned HTTP ${response.status}`);
  return { providerMessageId: body.name ?? messageId };
}
