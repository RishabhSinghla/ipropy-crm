import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  Check, Copy, Globe, MessageCircle, Phone, Plug, RefreshCw, Sparkles, Webhook, X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, EmptyState, Modal, Skeleton, Spinner, Tabs } from '../../components/ui';

const API_BASE = window.location.origin;

const WEBHOOK_ENDPOINTS = [
  { label: 'WhatsApp (Meta Cloud API)', path: '/api/webhooks/whatsapp', icon: MessageCircle, note: 'Set as the callback URL in your Meta app. The verify token comes from WHATSAPP_VERIFY_TOKEN.' },
  { label: 'Facebook Lead Ads', path: '/api/webhooks/leads/facebook', icon: Globe, note: 'Subscribe your page to the leadgen field.' },
  { label: 'Google Ads lead form', path: '/api/webhooks/leads/google', icon: Globe, note: 'Paste as the webhook URL; the key must match GOOGLE_ADS_WEBHOOK_KEY.' },
  { label: '99acres', path: '/api/webhooks/leads/portal/99acres', icon: Globe, note: 'Give this URL to your portal account manager.' },
  { label: 'MagicBricks', path: '/api/webhooks/leads/portal/magicbricks', icon: Globe },
  { label: 'Housing.com', path: '/api/webhooks/leads/portal/housing', icon: Globe },
  { label: 'NoBroker', path: '/api/webhooks/leads/portal/nobroker', icon: Globe },
  { label: 'Twilio — call status', path: '/api/webhooks/telephony/twilio/status', icon: Phone },
  { label: 'Twilio — incoming call', path: '/api/webhooks/telephony/twilio/incoming', icon: Phone, note: 'Set as the voice webhook on your Twilio number.' },
  { label: 'Exotel — call status', path: '/api/webhooks/telephony/exotel/status', icon: Phone },
  { label: 'Generic lead capture', path: '/api/webhooks/leads/generic', icon: Webhook, note: 'POST JSON with an X-Webform-Key header matching WEBFORM_PUBLIC_KEY.' },
];

export default function IntegrationsAdmin(): JSX.Element {
  const [tab, setTab] = useState('providers');
  const [copied, setCopied] = useState<string | null>(null);

  const { data: health, isLoading } = useQuery({
    queryKey: ['system-health'],
    queryFn: () => api.systemHealth(),
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

  const integrations = (health?.integrations ?? []) as unknown as {
    provider: string; kind: string; label: string; is_active: boolean;
    status: string; last_sync_at: string | null; last_error: string | null;
  }[];

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-slate-500">
          Credentials live in environment variables; these are the endpoints to give each provider.
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
          <div className="space-y-4">
            {['messaging', 'telephony', 'lead_source', 'email', 'ai'].map((kind) => {
              const list = integrations.filter((i) => i.kind === kind);
              if (!list.length) return null;
              return (
                <div key={kind} className="card overflow-hidden">
                  <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/40">
                    <p className="text-2xs font-semibold uppercase tracking-wide text-slate-500">
                      {kind.replace(/_/g, ' ')}
                    </p>
                  </div>
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {list.map((integration) => (
                      <li key={integration.provider} className="flex items-center gap-3 p-3">
                        <span className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          integration.is_active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700',
                        )} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{integration.label}</p>
                          <p className="font-mono text-2xs text-slate-400">{integration.provider}</p>
                          {integration.last_error && (
                            <p className="mt-0.5 text-2xs text-red-500">{integration.last_error}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {integration.last_sync_at && (
                            <span className="text-2xs text-slate-400">
                              synced {relativeTime(integration.last_sync_at)}
                            </span>
                          )}
                          <Badge color={integration.is_active ? '#22c55e' : '#94a3b8'}>
                            {integration.is_active ? 'Connected' : 'Not configured'}
                          </Badge>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              <p className="mb-1.5 font-medium text-slate-700 dark:text-slate-300">Configuring a provider</p>
              <p>
                Set the relevant environment variables in <code>.env</code> and restart the server.
                Every integration degrades gracefully — without credentials, messages and calls are
                still logged in the CRM so the workflows remain testable.
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
                      {copied === url ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      {copied === url ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 font-mono text-2xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    {url}
                  </code>
                  {endpoint.note && (
                    <p className="mt-1 text-2xs text-slate-500">{endpoint.note}</p>
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
                      <span className="ml-auto text-2xs text-slate-400 tnum">
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
            <p className="text-xs text-slate-500">
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
                      <td className="table-cell text-2xs text-slate-500">{relativeTime(row.received_at)}</td>
                      <td className="table-cell max-w-xs truncate text-2xs text-red-500">{row.error ?? '—'}</td>
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
