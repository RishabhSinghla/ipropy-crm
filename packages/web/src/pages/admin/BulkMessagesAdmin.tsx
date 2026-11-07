import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Megaphone, Pause, Play, Send, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Modal, Select, Skeleton, Spinner } from '../../components/ui';

/**
 * SMS and RCS to many people, through MSG91.
 *
 * Built like the WhatsApp Campaigns screen, for the same reason: nothing sends on
 * a click. You pick who, write what, are shown how many people that is and what the
 * first few would read, and only then is there a Send button — which passes that
 * number back, so a server that now counts something different refuses.
 *
 * "Everyone" is its own choice, on purpose. An empty list is never read as everybody.
 */
export default function BulkMessagesAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [building, setBuilding] = useState(false);

  const { data: status } = useQuery({ queryKey: ['bulk', 'status'], queryFn: () => api.bulkStatus() });
  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['bulk', 'list'], queryFn: () => api.bulkList(), refetchInterval: 30_000,
  });
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['bulk', 'list'] }); };

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: 'paused' | 'running' | 'cancelled' }) =>
      api.bulkSetStatus(input.id, input.status),
    onSuccess: () => { refresh(); toast.success('Campaign updated'); },
    onError: (err: Error) => toast.error('Could not change that', err.message),
  });

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">SMS &amp; RCS campaigns</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            One message, sent through MSG91 to everybody on a saved list — or to every record. You are
            shown how many people that is before anything goes. Messages leave in batches of 200 a
            minute, only between 9 am and 9 pm, and anyone who has asked not to be messaged is left out.
          </p>
        </div>
        <button className="btn-primary btn-sm ml-auto" onClick={() => setBuilding(true)} disabled={!status?.connected}>
          <Megaphone className="h-3.5 w-3.5" /> New campaign
        </button>
      </div>

      {!status?.connected && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          MSG91 is not switched on, so nothing can be sent. Add the Auth Key and switch the MSG91 card on in
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
                      <Badge>{campaign.channel.toUpperCase()}</Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {campaign.moduleName === 'leads' ? 'Contacts' : 'Inventory'}
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
                {all > 0 && (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                      <span className="bg-emerald-500" style={{ width: `${(campaign.counts.sent / all) * 100}%` }} />
                      <span className="bg-rose-500" style={{ width: `${(campaign.counts.failed / all) * 100}%` }} />
                      <span className="bg-amber-400" style={{ width: `${(campaign.counts.skipped / all) * 100}%` }} />
                    </div>
                    <p className="flex flex-wrap gap-x-4 text-xs text-muted">
                      <span><strong className="text-slate-700 dark:text-slate-200">{campaign.counts.sent}</strong> handed to MSG91</span>
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

/** One blank per line, `name = {{first_name}}`. Plain on purpose: the template defines its own blanks. */
function parseBlanks(text: string): Record<string, string> {
  const blanks: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key) blanks[key] = value;
  }
  return blanks;
}

function NewCampaign({ onClose }: { onClose: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'sms' | 'rcs'>('sms');
  const [module, setModule] = useState('leads');
  const [who, setWho] = useState(''); // a saved list's id, or 'everyone'
  const [templateId, setTemplateId] = useState('');
  const [blanks, setBlanks] = useState('name = {{label}}');
  const [body, setBody] = useState('');
  const [confirmLarge, setConfirmLarge] = useState(false);

  const { data: status } = useQuery({ queryKey: ['bulk', 'status'], queryFn: () => api.bulkStatus() });
  const { data: views } = useQuery({ queryKey: ['views', module], queryFn: () => api.views(module) });

  const audience = who === 'everyone' ? { everyone: true } : { view: who };
  const content = channel === 'sms'
    ? { channel, templateId: templateId.trim() || undefined, variables: parseBlanks(blanks) }
    : { channel, body };

  const preview = useMutation({
    mutationFn: () => api.bulkPreview({ module, audience, content }),
    onError: (err: Error) => toast.error('Could not work out who that is', err.message),
  });

  const send = useMutation({
    mutationFn: async () => {
      const campaign = await api.bulkCreate({ name, module, audience, content });
      return api.bulkApprove(campaign.id, preview.data!.reachable, confirmLarge);
    },
    onSuccess: (result) => {
      toast.success(
        `Sending to ${result.frozen.toLocaleString('en-IN')} people`,
        result.skipped ? `${result.skipped} were left out — open the campaign to see why.` : 'In batches, between 9 am and 9 pm.',
      );
      onClose();
    },
    onError: (err: Error) => toast.error('Not approved', err.message),
  });

  const channelReady = channel === 'sms' ? status?.smsReady || Boolean(templateId.trim()) : status?.rcsReady;
  const ready = Boolean(name.trim() && who && (channel === 'sms' ? true : body.trim()));
  const counted = preview.data;
  const large = (counted?.reachable ?? 0) > 500;
  const reset = (): void => preview.reset();

  return (
    <Modal
      open
      onClose={onClose}
      title="New SMS / RCS campaign"
      size="lg"
      footer={(
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-secondary" disabled={!ready || preview.isPending} onClick={() => preview.mutate()}>
            {preview.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
            Who would get this?
          </button>
          {counted && (
            <button
              className="btn-primary"
              disabled={send.isPending || counted.reachable === 0 || Boolean(counted.setupProblem) || (large && !confirmLarge)}
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
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Diwali offer, November" />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">How</span>
            <Select
              value={channel}
              onChange={(value) => { setChannel(value as 'sms' | 'rcs'); reset(); }}
              options={[{ value: 'sms', label: 'SMS' }, { value: 'rcs', label: 'RCS (rich message)' }]}
            />
          </label>
          <label className="block">
            <span className="label">Who</span>
            <Select
              value={module}
              onChange={(value) => { setModule(value); setWho(''); reset(); }}
              options={[{ value: 'leads', label: 'Contacts' }, { value: 'properties', label: 'Inventory' }]}
            />
          </label>
        </div>

        <label className="block">
          <span className="label">Which list</span>
          <Select
            value={who}
            onChange={(value) => { setWho(value); reset(); }}
            options={[
              { value: '', label: 'Choose a saved list…' },
              { value: 'everyone', label: 'Everyone — every record I can see' },
              ...(views ?? []).map((row) => ({ value: row.id, label: row.name })),
            ]}
          />
        </label>

        {channel === 'sms' ? (
          <>
            <label className="block">
              <span className="label">DLT template id (blank uses the one saved on the MSG91 card)</span>
              <input className="input" value={templateId} onChange={(event) => { setTemplateId(event.target.value); reset(); }}
                placeholder={status?.defaultSmsTemplateId || 'From MSG91 → SMS → Templates'} />
            </label>
            <label className="block">
              <span className="label">What fills the template&rsquo;s blanks — one per line</span>
              <textarea className="input min-h-20 font-mono text-xs" value={blanks}
                onChange={(event) => { setBlanks(event.target.value); reset(); }}
                placeholder={'name = {{label}}\nproject = {{project_name}}'} />
              <span className="mt-1 block text-2xs text-muted">
                Left side is the blank&rsquo;s name in your MSG91 template (##name##). Right side is a record
                field in {'{{double braces}}'}, or plain text. A record with an empty field is skipped, never sent a hole.
              </span>
            </label>
          </>
        ) : (
          <label className="block">
            <span className="label">The message</span>
            <textarea className="input min-h-24" value={body} maxLength={2000}
              onChange={(event) => { setBody(event.target.value); reset(); }}
              placeholder="Hi {{label}}, new launch in Sector 150 — tap to see plans." />
          </label>
        )}

        {!channelReady && (
          <p className="text-2xs text-amber-700">
            {channel === 'sms' ? 'No SMS template saved yet — paste the DLT template id above or on the MSG91 card.'
              : 'No RCS Project ID saved on the MSG91 card in Admin → Integrations.'}
          </p>
        )}

        {counted && (
          <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <p className="text-sm">
              <strong className="text-lg">{counted.reachable.toLocaleString('en-IN')}</strong> people would get this
              <span className="text-muted"> — out of {counted.total.toLocaleString('en-IN')} on that list.</span>
            </p>
            {counted.setupProblem && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                Nobody would get this yet. {counted.setupProblem}
              </p>
            )}
            {!counted.inSendingHours && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                It is outside 9 am – 9 pm India time. Promotional messages wait until 9 am; nothing is lost.
              </p>
            )}
            {counted.reachable === 0 && !counted.setupProblem && (
              <p className="text-sm text-rose-600">Nobody on that list has a mobile number we can message.</p>
            )}
            {counted.sample.map((row) => (
              <div key={row.recordId} className="rounded-lg bg-slate-50 p-2.5 text-sm dark:bg-slate-800/70">
                <p className="text-2xs font-semibold text-muted">{row.label} · {row.to}</p>
                <p className="mt-1 whitespace-pre-wrap">{row.preview}</p>
              </div>
            ))}
            {counted.skipped.length > 0 && (
              <p className="text-2xs text-muted">
                Left out in this sample: {counted.skipped.map((row) => `${row.label} (${row.reason})`).join(', ')}
              </p>
            )}
            {large && (
              <label className={cn(
                'flex items-start gap-2 rounded-lg border p-2.5 text-sm',
                confirmLarge ? 'border-slate-200 dark:border-slate-700' : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40',
              )}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  checked={confirmLarge} onChange={(event) => setConfirmLarge(event.target.checked)} />
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
