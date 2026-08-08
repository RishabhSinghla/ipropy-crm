import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  Check, CheckCircle2, Copy, Download, Globe, Loader2, MessageCircle, Phone, Plug, Sparkles, Webhook, X, XCircle,
} from 'lucide-react';
import { api, type IntegrationSummary } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, EmptyState, Skeleton, Spinner, Tabs, Toggle } from '../../components/ui';

const API_BASE = window.location.origin;

const WEBHOOK_ENDPOINTS = [
  { label: 'WhatsApp (Meta Cloud API)', path: '/api/webhooks/whatsapp', icon: MessageCircle, note: 'Set as the callback URL in your Meta app. The verify token is set below, under WhatsApp.' },
  { label: 'Facebook Lead Ads', path: '/api/webhooks/leads/facebook', icon: Globe, note: 'Subscribe your page to the leadgen field.' },
  { label: 'Google Ads lead form', path: '/api/webhooks/leads/google', icon: Globe, note: 'Paste as the webhook URL; the key must match what you set below, under Google Ads.' },
  { label: '99acres', path: '/api/webhooks/leads/portal/99acres', icon: Globe, note: 'Give this URL to your portal account manager.' },
  { label: 'MagicBricks', path: '/api/webhooks/leads/portal/magicbricks', icon: Globe },
  { label: 'Housing.com', path: '/api/webhooks/leads/portal/housing', icon: Globe },
  { label: 'NoBroker', path: '/api/webhooks/leads/portal/nobroker', icon: Globe },
  { label: 'Twilio — call status', path: '/api/webhooks/telephony/twilio/status', icon: Phone },
  { label: 'Twilio — incoming call', path: '/api/webhooks/telephony/twilio/incoming', icon: Phone, note: 'Set as the voice webhook on your Twilio number.' },
  { label: 'Exotel — call status', path: '/api/webhooks/telephony/exotel/status', icon: Phone },
  { label: 'Generic lead capture', path: '/api/webhooks/leads/generic', icon: Webhook, note: 'POST JSON with an X-Webform-Key header matching the webhook key set below, under Generic Web Form Capture.' },
];

interface FieldDef {
  key: string;
  label: string;
  source: 'config' | 'credentials';
  secret?: boolean;
  placeholder?: string;
}

const PROVIDER_FIELDS: Record<string, FieldDef[]> = {
  meta_whatsapp: [
    { key: 'phoneNumberId', label: 'Phone Number ID', source: 'credentials' },
    { key: 'businessAccountId', label: 'Business Account ID', source: 'credentials' },
    { key: 'accessToken', label: 'Access Token', source: 'credentials', secret: true },
    { key: 'appSecret', label: 'App Secret', source: 'credentials', secret: true },
    { key: 'verifyToken', label: 'Webhook Verify Token', source: 'config', placeholder: 'ipropy-verify-token' },
    { key: 'apiVersion', label: 'API Version', source: 'config', placeholder: 'v21.0' },
  ],
  twilio: [
    { key: 'accountSid', label: 'Account SID', source: 'credentials' },
    { key: 'authToken', label: 'Auth Token', source: 'credentials', secret: true },
    { key: 'callerId', label: 'Caller ID', source: 'config', placeholder: '+91...' },
    { key: 'appSid', label: 'TwiML App SID', source: 'config' },
  ],
  exotel: [
    { key: 'sid', label: 'Account SID', source: 'credentials' },
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'apiToken', label: 'API Token', source: 'credentials', secret: true },
    { key: 'subdomain', label: 'Subdomain', source: 'config', placeholder: 'api.exotel.com' },
    { key: 'callerId', label: 'Caller ID', source: 'config', placeholder: '+91...' },
  ],
  smtp: [
    { key: 'host', label: 'SMTP Host', source: 'config', placeholder: 'smtp.yourdomain.com' },
    { key: 'port', label: 'Port', source: 'config', placeholder: '587' },
    { key: 'secure', label: 'Use TLS — "true" or "false"', source: 'config', placeholder: 'false' },
    { key: 'user', label: 'Username', source: 'credentials' },
    { key: 'password', label: 'Password', source: 'credentials', secret: true },
    { key: 'from', label: 'From address', source: 'config', placeholder: 'iPropy CRM <no-reply@yourdomain.com>' },
  ],
  imap: [
    { key: 'host', label: 'IMAP Host', source: 'config' },
    { key: 'port', label: 'Port', source: 'config', placeholder: '993' },
    { key: 'user', label: 'Username', source: 'credentials' },
    { key: 'password', label: 'Password', source: 'credentials', secret: true },
  ],
  anthropic: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'claude-sonnet-5' },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'claude-haiku-4-5-20251001' },
    { key: 'maxTokens', label: 'Max tokens', source: 'config', placeholder: '4096' },
  ],
  ai_gemini: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'gemini-flash-latest' },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'gemini-flash-lite-latest' },
  ],
  ai_groq: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'llama-3.3-70b-versatile' },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'llama-3.1-8b-instant' },
  ],
  ai_openrouter: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'openrouter/free' },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'openrouter/free' },
  ],
  ai_openai: [
    { key: 'apiKey', label: 'API Key', source: 'credentials', secret: true },
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'https://api.openai.com/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'gpt-4o-mini' },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'gpt-4o-mini' },
  ],
  ai_ollama: [
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'http://localhost:11434/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'llama3.1' },
    { key: 'fastModel', label: 'Fast model', source: 'config', placeholder: 'llama3.1' },
  ],
  stt: [
    { key: 'apiKey', label: 'API Key (OpenAI-compatible Whisper)', source: 'credentials', secret: true },
    { key: 'baseUrl', label: 'Base URL', source: 'config', placeholder: 'https://api.openai.com/v1' },
    { key: 'model', label: 'Model', source: 'config', placeholder: 'whisper-1' },
  ],
  facebook_leads: [
    { key: 'appId', label: 'App ID', source: 'config' },
    { key: 'appSecret', label: 'App Secret', source: 'credentials', secret: true },
    { key: 'pageAccessToken', label: 'Page Access Token', source: 'credentials', secret: true },
    { key: 'verifyToken', label: 'Webhook Verify Token', source: 'config', placeholder: 'ipropy-fb-verify' },
  ],
  google_ads: [
    { key: 'webhookKey', label: 'Webhook Key', source: 'credentials', secret: true },
  ],
  s3: [
    { key: 'driver', label: 'Driver — "local" or "s3"', source: 'config', placeholder: 'local' },
    { key: 'bucket', label: 'Bucket', source: 'config', placeholder: 'ipropy-files' },
    { key: 'region', label: 'Region', source: 'config', placeholder: 'ap-south-1' },
    { key: 'endpoint', label: 'Custom endpoint (MinIO/other S3-compatible)', source: 'config', placeholder: 'https://s3.ap-south-1.amazonaws.com' },
    { key: 'accessKeyId', label: 'Access Key ID', source: 'credentials' },
    { key: 'secretAccessKey', label: 'Secret Access Key', source: 'credentials', secret: true },
  ],
  webform: [
    { key: 'key', label: 'Public Webhook Key', source: 'config', placeholder: 'ipropy-public-webform' },
  ],
};

const TESTABLE = new Set([
  'meta_whatsapp', 'twilio', 'exotel', 'smtp', 'imap', 'facebook_leads',
  'anthropic', 'ai_gemini', 'ai_groq', 'ai_openrouter', 'ai_openai', 'ai_ollama',
]);

/**
 * Where to get a key, shown on the card. Only the AI providers have these
 * because they are the ones an operator is expected to sign up for themselves
 * — the rest are configured by whoever already owns the account.
 */
const PROVIDER_HINTS: Record<string, { text: string; href?: string; linkLabel?: string; free?: boolean }> = {
  anthropic: {
    text: 'Best quality, paid. Billing required.',
    href: 'https://console.anthropic.com/settings/keys',
    linkLabel: 'Get a key',
  },
  ai_gemini: {
    free: true,
    text: 'Free tier, no card needed — the most generous free option (1M-token context). Note Google may train on free-tier prompts.',
    href: 'https://aistudio.google.com/apikey',
    linkLabel: 'Get a free key',
  },
  ai_groq: {
    free: true,
    text: 'Free tier, no card needed. Fastest responses of the free options.',
    href: 'https://console.groq.com/keys',
    linkLabel: 'Get a free key',
  },
  ai_openrouter: {
    free: true,
    text: 'Free tier, no card needed. Keep the model as openrouter/free — individual “:free” model ids get retired without notice.',
    href: 'https://openrouter.ai/keys',
    linkLabel: 'Get a free key',
  },
  ai_openai: {
    text: 'Any OpenAI-compatible endpoint — OpenAI, Together, Fireworks, vLLM.',
    href: 'https://platform.openai.com/api-keys',
    linkLabel: 'Get a key',
  },
  ai_ollama: {
    free: true,
    text: 'Free and fully local — nothing leaves this machine. Needs `ollama serve` running.',
    href: 'https://ollama.com/download',
    linkLabel: 'Install Ollama',
  },
};

function ProviderCard({ summary }: { summary: IntegrationSummary }): JSX.Element {
  const queryClient = useQueryClient();
  const fields = PROVIDER_FIELDS[summary.provider] ?? [];
  const hint = PROVIDER_HINTS[summary.provider];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.source === 'config' ? (summary.config[f.key] ?? '') : ''])),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const setField = (key: string, v: string): void => setValues((prev) => ({ ...prev, [key]: v }));

  const save = async (): Promise<void> => {
    setSaving(true);
    setTestResult(null);
    try {
      const configPatch: Record<string, string> = {};
      const credentialsPatch: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.key] ?? '';
        if (f.source === 'config') configPatch[f.key] = v;
        else if (v) credentialsPatch[f.key] = v; // blank credential = leave unchanged
      }
      await api.saveIntegration(summary.provider, { config: configPatch, credentials: credentialsPatch });
      toast.success(`${summary.label} saved`);
      // Clear typed secrets from the form — they're persisted now, and we never
      // want a plaintext secret sitting in component state longer than needed.
      setValues((prev) => {
        const next = { ...prev };
        for (const f of fields) if (f.secret) next[f.key] = '';
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testIntegration(summary.provider);
      setTestResult(result);
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const toggleActive = async (next: boolean): Promise<void> => {
    try {
      await api.saveIntegration(summary.provider, { isActive: next });
      toast.success(next ? `${summary.label} enabled` : `${summary.label} disabled`);
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      toast.error('Could not update', (err as Error).message);
    }
  };

  const syncNow = async (): Promise<void> => {
    setSyncing(true);
    setTestResult(null);
    try {
      const result = await api.syncImapInbound(50);
      setTestResult({
        ok: result.errors.length === 0,
        message: result.errors[0]
          ?? `Imported ${result.imported} of ${result.checked} messages${result.matched ? `, linked to records` : ''}.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', summary.isActive ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700')} />
        <p className="text-sm font-medium">{summary.label}</p>
        <Badge color={summary.isActive ? '#22c55e' : '#94a3b8'}>{summary.isActive ? 'Active' : 'Inactive'}</Badge>
        {summary.lastSyncAt && (
          <span className="text-2xs text-muted">verified {relativeTime(summary.lastSyncAt)}</span>
        )}
        <Toggle checked={summary.isActive} onChange={(next) => void toggleActive(next)} className="ml-auto" />
      </div>

      {hint && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs text-muted dark:border-slate-800 dark:bg-slate-800/30">
          {hint.free && <Badge color="#22c55e">Free tier</Badge>}
          <span className="min-w-0 flex-1">{hint.text}</span>
          {hint.href && (
            <a
              href={hint.href}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {hint.linkLabel ?? 'Open'} →
            </a>
          )}
        </div>
      )}

      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {fields.map((f) => {
          const preview = f.secret ? summary.credentialFields[f.key] : undefined;
          return (
            <div key={f.key} className={fields.length === 1 ? 'sm:col-span-2' : ''}>
              <label className="label">{f.label}</label>
              <input
                type={f.secret ? 'password' : 'text'}
                className="input"
                value={values[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={preview?.set ? `Saved (${preview.preview}) — leave blank to keep` : f.placeholder}
              />
            </div>
          );
        })}
      </div>

      {summary.lastError && !testResult && (
        <div className="mx-4 mb-3 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {summary.lastError}
        </div>
      )}
      {testResult && (
        <div className={cn(
          'mx-4 mb-3 flex items-start gap-1.5 rounded-lg border p-2.5 text-xs',
          testResult.ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
            : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
        )}>
          {testResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {testResult.message}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <button className="btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving && <Spinner className="h-3 w-3" />} Save
        </button>
        {TESTABLE.has(summary.provider) && (
          <button className="btn-secondary btn-sm" disabled={testing} onClick={() => void test()}>
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />} Test connection
          </button>
        )}
        {summary.provider === 'imap' && (
          <button className="btn-secondary btn-sm" disabled={syncing} onClick={() => void syncNow()}>
            {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Sync now
          </button>
        )}
      </div>
    </div>
  );
}

export default function IntegrationsAdmin(): JSX.Element {
  const [tab, setTab] = useState('providers');
  const [copied, setCopied] = useState<string | null>(null);

  const { data: integrations, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.integrations(),
  });

  const { data: webforms } = useQuery({
    queryKey: ['webforms'],
    queryFn: () => api.webforms(),
    enabled: tab === 'webforms',
  });

  const { data: inbox } = useQuery({
    queryKey: ['lead-inbox'],
    queryFn: () => api.leadInbox(),
    enabled: tab === 'inbox',
  });

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  const KIND_LABELS: Record<string, string> = {
    messaging: 'WhatsApp', telephony: 'Telephony', lead_source: 'Lead sources', email: 'Email', ai: 'AI', storage: 'Storage',
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted">
          Configure every provider from here — nothing needs editing in <code>.env</code> or a redeploy.
        </p>
      </div>

      <Tabs
        tabs={[
          { key: 'providers', label: 'Providers', icon: <Plug className="h-3.5 w-3.5" /> },
          { key: 'webhooks', label: 'Webhook URLs', icon: <Webhook className="h-3.5 w-3.5" /> },
          { key: 'webforms', label: 'Web forms', icon: <Globe className="h-3.5 w-3.5" /> },
          { key: 'inbox', label: 'Lead inbox', icon: <Sparkles className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'providers' && (
        isLoading ? (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : (
          <div className="space-y-6">
            {['messaging', 'telephony', 'email', 'ai', 'lead_source', 'storage'].map((kind) => {
              const list = (integrations ?? []).filter((i) => i.kind === kind && PROVIDER_FIELDS[i.provider]);
              if (!list.length) return null;
              return (
                <div key={kind}>
                  <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                    {KIND_LABELS[kind] ?? kind.replace(/_/g, ' ')}
                  </p>
                  <div className="space-y-3">
                    {list.map((summary) => <ProviderCard key={summary.provider} summary={summary} />)}
                  </div>
                </div>
              );
            })}

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900 text-muted">
              <p className="mb-1.5 font-medium text-slate-700 dark:text-slate-300">How this works</p>
              <p>
                Every integration degrades gracefully — without credentials, messages and calls are still
                logged in the CRM so workflows stay testable. Saving credentials here activates the
                provider automatically; use the toggle to switch one off without clearing what you entered.
                Secrets are encrypted before they're stored and are never sent back to the browser — the
                fields above show only a masked preview of what's already saved.
              </p>
            </div>
          </div>
        )
      )}

      {tab === 'webhooks' && (
        <div className="card overflow-hidden">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {WEBHOOK_ENDPOINTS.map((endpoint) => {
              const url = `${API_BASE}${endpoint.path}`;
              return (
                <li key={endpoint.path} className="p-3">
                  <div className="flex items-center gap-2.5">
                    <endpoint.icon className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="text-sm font-medium">{endpoint.label}</span>
                    <button
                      onClick={() => copy(url)}
                      className="btn-ghost btn-sm ml-auto shrink-0"
                    >
                      {copied === url ? <Check className="h-3 w-3 text-positive" /> : <Copy className="h-3 w-3" />}
                      {copied === url ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 font-mono text-2xs dark:bg-slate-800 text-muted">
                    {url}
                  </code>
                  {endpoint.note && (
                    <p className="mt-1 text-2xs text-muted">{endpoint.note}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tab === 'webforms' && (
        <div className="card overflow-hidden">
          {!webforms?.length ? (
            <EmptyState
              icon={<Globe className="h-8 w-8" />}
              title="No web forms yet"
              body="Create a form to capture leads from your website or a landing page."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {(webforms as { id: string; name: string; embedUrl: string; submission_count: number; is_active: boolean }[])
                .map((form) => (
                  <li key={form.id} className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{form.name}</span>
                      <Badge color={form.is_active ? '#22c55e' : '#94a3b8'}>
                        {form.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                      <span className="ml-auto text-2xs text-muted tnum">
                        {form.submission_count} submissions
                      </span>
                    </div>
                    <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 font-mono text-2xs dark:bg-slate-800">
                      {form.embedUrl}
                    </code>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'inbox' && (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Raw inbound leads</p>
            <p className="text-xs text-muted">
              Every payload is stored before processing, so a mapping problem never loses a lead.
            </p>
          </div>
          {!inbox?.length ? (
            <EmptyState title="No inbound leads recorded yet" />
          ) : (
            <table className="w-full">
              <thead>
                <tr>{['Source', 'Status', 'Received', 'Error'].map((h) => <th key={h} className="table-head">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(inbox as { id: string; source: string; status: string; received_at: string; error: string | null; record_id: string | null }[])
                  .map((row) => (
                    <tr key={row.id}>
                      <td className="table-cell font-medium capitalize">{row.source.replace(/_/g, ' ')}</td>
                      <td className="table-cell">
                        <Badge color={
                          row.status === 'processed' ? '#22c55e'
                            : row.status === 'duplicate' ? '#f59e0b'
                            : row.status === 'failed' ? '#ef4444' : '#94a3b8'
                        }>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="table-cell text-2xs text-muted">{relativeTime(row.received_at)}</td>
                      <td className="table-cell max-w-xs truncate text-2xs text-negative">{row.error ?? '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
