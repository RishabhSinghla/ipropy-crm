import { type JSX, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Megaphone, Pause, Play, Send, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Modal, Select, Skeleton, Spinner } from '../../components/ui';

/**
 * Sending one approved template to many people.
 *
 * **The screen's job is to make the number unmissable.** On 13 and 16
 * September a daily workflow whose conditions had emptied itself queued 40,515
 * WhatsApp messages to 20,209 people in this CRM, and nobody received one only
 * because no provider was connected. So nothing here sends on a click: you
 * pick an audience, you are shown how many people that is and what the first
 * few would actually read, and only then is there an Approve button — which
 * passes that number back, so a server that now counts something different
 * refuses.
 *
 * Two numbers, not one. "1,200 contacts" and "340 of them have a WhatsApp
 * number" are different facts, and the second is the one that matters.
 */
export default function CampaignsAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [building, setBuilding] = useState(false);

  const { data: status } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['wa-biz', 'campaigns'], queryFn: () => api.waBizCampaigns(), refetchInterval: 30_000,
  });

  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['wa-biz', 'campaigns'] }); };

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: 'paused' | 'running' | 'cancelled' }) =>
      api.waBizCampaignStatus(input.id, input.status),
    onSuccess: () => { refresh(); toast.success('Campaign updated'); },
    onError: (err: Error) => toast.error('Could not change that', err.message),
  });

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Campaigns</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            One approved template, sent to everybody in a saved list. You are shown how many people
            that is before anything goes, and messages leave slowly — about ten a minute — so a
            campaign started by mistake can be stopped after ten people rather than ten thousand.
          </p>
        </div>
        <button className="btn-primary btn-sm ml-auto" onClick={() => setBuilding(true)} disabled={!status?.connected}>
          <Megaphone className="h-3.5 w-3.5" /> New campaign
        </button>
      </div>

      {!status?.connected && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          No WhatsApp provider is switched on, so nothing can be sent. Connect one in
          Admin → Integrations first.
        </p>
      )}

      {!campaigns?.length ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-muted dark:border-slate-700">
          No campaigns yet.
        </p>
      ) : (
        <div className="space-y-2">
          {campaigns.map((campaign) => {
            const done = campaign.counts.sent + campaign.counts.failed + campaign.counts.skipped;
            const all = done + campaign.counts.pending;
            return (
              <section key={campaign.id} className="card p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-semibold">
                      {campaign.name}
                      <Badge color={TONE[campaign.status]}>{LABEL[campaign.status]}</Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {campaign.templateName} · {campaign.moduleName === 'leads' ? 'Contacts' : 'Inventory'}
                      {campaign.approvedCount !== null && ` · approved for ${campaign.approvedCount.toLocaleString('en-IN')} people`}
                    </p>
                  </div>
                  {campaign.status === 'running' && (
                    <button className="btn-secondary btn-sm" onClick={() => setStatus.mutate({ id: campaign.id, status: 'paused' })}>
                      <Pause className="h-3.5 w-3.5" /> Pause
                    </button>
                  )}
                  {campaign.status === 'paused' && (
                    <button className="btn-secondary btn-sm" onClick={() => setStatus.mutate({ id: campaign.id, status: 'running' })}>
                      <Play className="h-3.5 w-3.5" /> Resume
                    </button>
                  )}
                  {(campaign.status === 'running' || campaign.status === 'paused') && (
                    <button className="btn-secondary btn-sm" onClick={() => setStatus.mutate({ id: campaign.id, status: 'cancelled' })}>
                      <Ban className="h-3.5 w-3.5" /> Stop
                    </button>
                  )}
                </div>

                {/* What became of each person, which is the campaign's own record
                    of itself: sent, refused, and skipped with a reason. */}
                {all > 0 && (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                      <span className="bg-emerald-500" style={{ width: `${(campaign.counts.sent / all) * 100}%` }} />
                      <span className="bg-rose-500" style={{ width: `${(campaign.counts.failed / all) * 100}%` }} />
                      <span className="bg-amber-400" style={{ width: `${(campaign.counts.skipped / all) * 100}%` }} />
                    </div>
                    <p className="flex flex-wrap gap-x-4 text-xs text-muted">
                      <span><strong className="text-slate-700 dark:text-slate-200">{campaign.counts.sent}</strong> sent</span>
                      {campaign.counts.failed > 0 && <span><strong className="text-rose-600">{campaign.counts.failed}</strong> failed</span>}
                      {campaign.counts.skipped > 0 && <span><strong className="text-amber-600">{campaign.counts.skipped}</strong> skipped</span>}
                      {campaign.counts.pending > 0 && <span>{campaign.counts.pending} to go</span>}
                    </p>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {building && <NewCampaign onClose={() => { setBuilding(false); refresh(); }} />}
    </div>
  );
}

const LABEL: Record<string, string> = {
  draft: 'Not approved', running: 'Sending', paused: 'Paused', done: 'Finished', cancelled: 'Stopped',
};
const TONE: Record<string, string | undefined> = {
  draft: undefined, running: '#2563eb', paused: '#f59e0b', done: '#14b86a', cancelled: '#64748b',
};

/**
 * Building one: pick, look, then approve.
 *
 * The Approve button does not exist until the preview has been read, and it
 * carries the number that was on the screen when it was pressed.
 */
function NewCampaign({ onClose }: { onClose: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [module, setModule] = useState('leads');
  const [templateId, setTemplateId] = useState('');
  const [view, setView] = useState('');
  const [confirmLarge, setConfirmLarge] = useState(false);

  const { data: templates } = useQuery({ queryKey: ['wa-biz', 'saved-templates'], queryFn: () => api.waBizSavedTemplates() });
  const { data: views } = useQuery({ queryKey: ['views', module], queryFn: () => api.views(module) });

  const approved = useMemo(
    () => (templates ?? []).filter((template) => template.status === 'APPROVED'),
    [templates],
  );

  const preview = useMutation({
    mutationFn: () => api.waBizCampaignPreview({ module, templateId, audience: { view } }),
    onError: (err: Error) => toast.error('Could not work out who that is', err.message),
  });

  const send = useMutation({
    mutationFn: async () => {
      const campaign = await api.waBizCampaignCreate({ name, module, templateId, audience: { view } });
      return api.waBizCampaignApprove(campaign.id, preview.data!.reachable, confirmLarge);
    },
    onSuccess: (result) => {
      toast.success(
        `Sending to ${result.frozen.toLocaleString('en-IN')} people`,
        result.skipped ? `${result.skipped} were skipped — open the campaign to see why.` : 'About ten a minute.',
      );
      onClose();
    },
    onError: (err: Error) => toast.error('Not approved', err.message),
  });

  const ready = Boolean(name.trim() && templateId && view);
  const counted = preview.data;
  const large = (counted?.reachable ?? 0) > 500;

  return (
    <Modal
      open
      onClose={onClose}
      title="New campaign"
      size="lg"
      footer={(
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-secondary" disabled={!ready || preview.isPending} onClick={() => preview.mutate()}>
            {preview.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
            Who would get this?
          </button>
          {/* Only after the number has been on the screen. */}
          {counted && (
            <button
              className="btn-primary"
              disabled={send.isPending || counted.reachable === 0 || (large && !confirmLarge)}
              onClick={() => send.mutate()}
            >
              {send.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              Send to {counted.reachable.toLocaleString('en-IN')}
            </button>
          )}
        </>
      )}
    >
      <div className="space-y-3">
        <label className="block">
          <span className="label">What is it called?</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Diwali offer, September" />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Who</span>
            <Select
              value={module}
              onChange={(value) => { setModule(value); setView(''); preview.reset(); }}
              options={[{ value: 'leads', label: 'Contacts' }, { value: 'properties', label: 'Inventory' }]}
            />
          </label>
          <label className="block">
            <span className="label">Which list</span>
            <Select
              value={view}
              onChange={(value) => { setView(value); preview.reset(); }}
              options={[
                { value: '', label: 'Choose a saved list…' },
                ...(views ?? []).map((row) => ({ value: row.id, label: row.name })),
              ]}
            />
          </label>
        </div>

        <label className="block">
          <span className="label">Which approved template</span>
          <Select
            value={templateId}
            onChange={(value) => { setTemplateId(value); preview.reset(); }}
            options={[
              { value: '', label: 'Choose a template…' },
              ...approved.map((template) => ({ value: template.id, label: template.name })),
            ]}
          />
          {!approved.length && (
            <span className="mt-1 block text-2xs text-muted">
              No approved templates yet. Sync them in Admin → WhatsApp Templates and map their blanks.
            </span>
          )}
        </label>

        {counted && (
          <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <p className="text-sm">
              <strong className="text-lg">{counted.reachable.toLocaleString('en-IN')}</strong> people would get this
              <span className="text-muted"> — out of {counted.total.toLocaleString('en-IN')} on that list.</span>
            </p>
            {counted.reachable === 0 && (
              <p className="text-sm text-rose-600">Nobody on that list has a WhatsApp number.</p>
            )}

            {/* The wording, filled in, for real people. A positional template
                is unreadable in the abstract. */}
            {counted.sample.map((row) => (
              <div key={row.recordId} className="rounded-lg bg-slate-50 p-2.5 text-sm dark:bg-slate-800/70">
                <p className="text-2xs font-semibold text-muted">{row.label} · {row.to}</p>
                <p className="mt-1 whitespace-pre-wrap">{row.preview}</p>
                {row.missing.length > 0 && (
                  <p className="mt-1 text-2xs font-medium text-rose-600">
                    Will be skipped: {row.missing.join('; ')}
                  </p>
                )}
              </div>
            ))}

            {counted.skipped.length > 0 && (
              <p className="text-2xs text-muted">
                Skipped in this sample: {counted.skipped.map((row) => `${row.label} (${row.reason})`).join(', ')}
              </p>
            )}

            {large && (
              <label className={cn(
                'flex items-start gap-2 rounded-lg border p-2.5 text-sm',
                confirmLarge ? 'border-slate-200 dark:border-slate-700' : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40',
              )}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  checked={confirmLarge}
                  onChange={(event) => setConfirmLarge(event.target.checked)}
                />
                <span>
                  This is a large campaign. I have read the number above and I want to send it to
                  {' '}{counted.reachable.toLocaleString('en-IN')} people.
                </span>
              </label>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
