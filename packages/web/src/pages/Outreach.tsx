import type { JSX } from 'react';
/**
 * Outreach — everything that messages more than one person.
 *
 * The organising idea is the channel banner at the top. Whether WhatsApp can
 * send by itself or needs a human to tap send changes what every screen below
 * promises, and pretending otherwise is how software ends up claiming it sent
 * two hundred messages that are sitting in a queue.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, ChevronRight, Clock, MessageSquare, Pencil, Play, Plus, Send, Trash2, Users, X, Zap,
} from 'lucide-react';
import { api, type AutoReplyRule, type Broadcast, type DeviceSend, type Sequence, type SequenceStep } from '../lib/api';
import { toast } from '../lib/store';
import {
  Badge, Card, ConfirmDialog, EmptyState, Input, Modal, ProgressBar, Select, Spinner, Tabs, Textarea, Toggle,
} from '../components/ui';
import { relativeTime } from '@ipropy/shared';

type TabKey = 'queue' | 'broadcasts' | 'sequences' | 'autoreply';

export default function Outreach(): JSX.Element {
  const [tab, setTab] = useState<TabKey>('queue');

  const { data: channel } = useQuery({
    queryKey: ['outreach', 'channel'],
    queryFn: () => api.outreachChannel(),
  });
  const { data: queue } = useQuery({
    queryKey: ['outreach', 'queue'],
    queryFn: () => api.deviceQueue(),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold sm:text-2xl">Outreach</h1>
        <p className="text-sm text-muted">Send to many people, and keep following up without remembering to.</p>
      </header>

      {channel && <ChannelBanner channel={channel} />}

      <Tabs
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
        tabs={[
          { key: 'queue', label: 'Send queue', icon: <Send className="h-4 w-4" />, count: queue?.length ?? 0 },
          { key: 'broadcasts', label: 'Broadcasts', icon: <Users className="h-4 w-4" /> },
          { key: 'sequences', label: 'Sequences', icon: <Clock className="h-4 w-4" /> },
          { key: 'autoreply', label: 'Auto-replies', icon: <Zap className="h-4 w-4" /> },
        ]}
      />

      {tab === 'queue' && <SendQueue />}
      {tab === 'broadcasts' && <Broadcasts apiReady={channel?.apiReady ?? false} />}
      {tab === 'sequences' && <Sequences />}
      {tab === 'autoreply' && <AutoReplies />}
    </div>
  );
}

function ChannelBanner({ channel }: { channel: { apiReady: boolean; message: string } }): JSX.Element {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${
        channel.apiReady
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40'
          : 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40'
      }`}
    >
      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">{channel.apiReady ? 'WhatsApp connected' : 'One-tap mode'}</p>
        <p className="text-muted">{channel.message}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Send queue — the zero-account path
// ---------------------------------------------------------------------------

function SendQueue(): JSX.Element {
  const client = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['outreach', 'queue'],
    queryFn: () => api.deviceQueue(),
    refetchInterval: 30_000,
  });

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['outreach', 'queue'] });
  };

  const done = useMutation({
    mutationFn: (id: string) => api.deviceSendDone(id),
    onSuccess: () => { invalidate(); toast.success('Logged as sent'); },
  });
  const skip = useMutation({
    mutationFn: (id: string) => api.deviceSendSkip(id),
    onSuccess: invalidate,
  });

  if (isLoading) return <Spinner className="mx-auto mt-8 h-6 w-6" />;
  if (!data?.length) {
    return (
      <EmptyState
        icon={<Send className="h-8 w-8" />}
        title="Nothing waiting to send"
        body="Messages queued by a broadcast or a follow-up sequence appear here, already written, ready to send in one tap."
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">
        {data.length} message{data.length === 1 ? '' : 's'} ready. Tapping <strong>Open WhatsApp</strong> opens
        the chat with the message already typed — you press send.
      </p>
      {data.map((item) => (
        <QueueRow
          key={item.id}
          item={item}
          onSent={() => done.mutate(item.id)}
          onSkip={() => skip.mutate(item.id)}
          onEdited={invalidate}
        />
      ))}
    </div>
  );
}

function QueueRow({
  item, onSent, onSkip, onEdited,
}: { item: DeviceSend; onSent: () => void; onSkip: () => void; onEdited: () => void }): JSX.Element {
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.body);
  const [saving, setSaving] = useState(false);

  const open = (): void => {
    setOpened(true);
    void api.deviceSendOpened(item.id).catch(() => undefined);
    // A new tab, not a redirect: on desktop this hands off to WhatsApp Web and
    // the queue must still be here when they come back.
    window.open(item.link, '_blank', 'noopener,noreferrer');
  };

  const save = async (): Promise<void> => {
    if (!draft.trim() || draft === item.body) { setEditing(false); return; }
    setSaving(true);
    try {
      await api.editDeviceSend(item.id, draft.trim());
      setEditing(false);
      // The link is built from the body server-side, so a stale row here would
      // send the old wording however carefully it was edited.
      onEdited();
      toast.success('Message updated');
    } catch (err) {
      toast.error('Could not save that', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{item.name ?? item.handle}</p>
          <p className="text-2xs text-muted">{item.handle}{item.reason ? ` · ${item.reason}` : ''}</p>
        </div>
        <span className="text-2xs text-muted">{relativeTime(item.createdAt)}</span>
      </div>

      {editing ? (
        <div className="mt-2">
          <Textarea
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={1500}
            autoFocus
            // Escape backs out, ⌘↵ saves — the two things a hand already on the
            // keyboard reaches for before it reaches for a button.
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setDraft(item.body); setEditing(false); }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save();
            }}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button onClick={() => void save()} disabled={saving || !draft.trim()} className="btn-primary text-sm">
              {saving ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
              Save
            </button>
            <button
              onClick={() => { setDraft(item.body); setEditing(false); }}
              className="btn-ghost text-sm text-muted"
            >
              Cancel
            </button>
            <span className="ml-auto text-2xs text-muted tnum">{draft.length}/1500</span>
          </div>
        </div>
      ) : (
        <div className="group relative mt-2">
          <p className="whitespace-pre-wrap rounded bg-slate-50 p-2 pr-9 text-sm dark:bg-slate-900">{item.body}</p>
          <button
            onClick={() => { setDraft(item.body); setEditing(true); }}
            aria-label="Edit this message"
            title="Edit this message"
            className="absolute right-1.5 top-1.5 rounded p-1.5 text-slate-400 hover:bg-white hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={open} disabled={editing} className="btn-primary text-sm disabled:opacity-40">
          <Send className="mr-1.5 h-3.5 w-3.5" /> Open WhatsApp
        </button>
        {/* Only offered after opening: marking a message sent that was never
            opened is the one way this queue can quietly lie. */}
        {opened && !editing && (
          <button onClick={onSent} className="btn-secondary text-sm">
            <Check className="mr-1.5 h-3.5 w-3.5" /> I sent it
          </button>
        )}
        {!editing && <button onClick={onSkip} className="btn-ghost text-sm text-muted">Skip</button>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

function Broadcasts({ apiReady }: { apiReady: boolean }): JSX.Element {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['outreach', 'broadcasts'],
    queryFn: () => api.broadcasts(),
    // Only while something is moving — polling a finished list forever is
    // wasted battery on the phones this runs on.
    refetchInterval: (query) => {
      const rows = query.state.data as Broadcast[] | undefined;
      return rows?.some((b) => b.status === 'running') ? 2000 : false;
    },
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'pause' | 'cancel' }) =>
      action === 'start' ? api.startBroadcast(id)
        : action === 'pause' ? api.pauseBroadcast(id) : api.cancelBroadcast(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['outreach', 'broadcasts'] }),
    onError: (err: Error) => toast.error('Could not do that', err.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setCreating(true)} className="btn-primary text-sm">
          <Plus className="mr-1.5 h-4 w-4" /> New broadcast
        </button>
      </div>

      {isLoading && <Spinner className="mx-auto mt-8 h-6 w-6" />}

      {!isLoading && !data?.length && (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="No broadcasts yet"
          body="Send one message to a filtered list of leads — a price change, a launch, an open-house invite."
        />
      )}

      {data?.map((b) => (
        <Card key={b.id} className="p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <button onClick={() => setDetailId(b.id)} className="text-left font-medium hover:underline">
                {b.name}
              </button>
              <p className="text-2xs text-muted">
                {b.channel_mode === 'device' ? 'One-tap' : 'Automatic'} ·
                {' '}{b.total_count} recipient{b.total_count === 1 ? '' : 's'}
                {b.blocked_count > 0 && ` · ${b.blocked_count} skipped`}
              </p>
            </div>
            <Badge color={statusColour(b.status)}>{b.status}</Badge>
          </div>

          {(b.status === 'running' || b.sent_count > 0) && (
            <div className="mt-2 space-y-1">
              <ProgressBar value={b.sent_count} max={Math.max(1, b.total_count)} />
              <p className="text-2xs text-muted tnum">
                {b.sent_count} of {b.total_count}
                {b.failed_count > 0 && ` · ${b.failed_count} failed`}
              </p>
            </div>
          )}

          <div className="mt-3 flex gap-2">
            {(b.status === 'draft' || b.status === 'paused' || b.status === 'scheduled') && (
              <button onClick={() => act.mutate({ id: b.id, action: 'start' })} className="btn-primary text-sm">
                <Play className="mr-1.5 h-3.5 w-3.5" /> {b.status === 'paused' ? 'Resume' : 'Send'}
              </button>
            )}
            {b.status === 'running' && (
              <button onClick={() => act.mutate({ id: b.id, action: 'pause' })} className="btn-secondary text-sm">
                Pause
              </button>
            )}
            <button onClick={() => setDetailId(b.id)} className="btn-ghost text-sm">
              Details <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </button>
          </div>
        </Card>
      ))}

      {creating && <NewBroadcastModal apiReady={apiReady} onClose={() => setCreating(false)} />}
      {detailId && <BroadcastDetail id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function statusColour(status: string): string {
  return status === 'completed' ? '#16a34a'
    : status === 'running' ? '#0891b2'
      : status === 'paused' ? '#ca8a04'
        : status === 'cancelled' ? '#dc2626' : '#64748b';
}

function NewBroadcastModal({ apiReady, onClose }: { apiReady: boolean; onClose: () => void }): JSX.Element {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'api' | 'device'>(apiReady ? 'api' : 'device');
  const [body, setBody] = useState('Hi {{first_name}}, ');
  const [templateName, setTemplateName] = useState('');
  const [viewId, setViewId] = useState('');

  const { data: views } = useQuery({ queryKey: ['views', 'leads'], queryFn: () => api.views('leads') });
  const { data: templates } = useQuery({ queryKey: ['wa-templates'], queryFn: () => api.whatsappTemplates() });

  const { data: audience, isFetching } = useQuery({
    queryKey: ['broadcast-audience', viewId],
    queryFn: async () => {
      return api.list('leads', { view: viewId, pageSize: 1, page: 1 });
    },
    enabled: Boolean(viewId && views?.length),
  });

  const create = useMutation({
    mutationFn: () => api.createBroadcast({
      name,
      channelMode: mode,
      bodyText: mode === 'device' || !templateName ? body : null,
      templateName: mode === 'api' && templateName ? templateName : null,
      module: 'leads',
      viewId,
    }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['outreach', 'broadcasts'] });
      toast.success(
        `Broadcast created — ${result.total} recipient${result.total === 1 ? '' : 's'}`,
        result.skipped ? `${result.skipped} skipped (no number, opted out, or do-not-contact)` : undefined,
      );
      onClose();
    },
    onError: (err: Error) => toast.error('Could not create the broadcast', err.message),
  });

  const canSubmit = name.trim() && viewId && (audience?.total ?? 0) > 0
    && (mode === 'device' ? body.trim() : (templateName || body.trim()));

  return (
    <Modal
      open
      onClose={onClose}
      title="New broadcast"
      size="lg"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => create.mutate()}
            disabled={!canSubmit || create.isPending}
            className="btn-primary"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="February price revision" />
        </div>

        <div>
          <label className="label">Audience</label>
          <Select
            value={viewId}
            onChange={setViewId}
            placeholder="Choose a saved list of leads…"
            options={(views ?? []).map((v) => ({ value: v.id, label: v.name }))}
          />
          {viewId && (
            <p className="mt-1 text-2xs text-muted">
              {isFetching ? 'Counting…' : `${audience?.total ?? 0} lead${audience?.total === 1 ? '' : 's'} in this list`}
            </p>
          )}
        </div>

        <div>
          <label className="label">How it sends</label>
          <div className="space-y-2">
            <ModeOption
              selected={mode === 'device'}
              onSelect={() => setMode('device')}
              title="One tap each, from your phone"
              detail="No WhatsApp Business account needed. Messages are written for you and queued; your team taps send. Works today."
            />
            <ModeOption
              selected={mode === 'api'}
              onSelect={() => apiReady && setMode('api')}
              disabled={!apiReady}
              title="Automatically"
              detail={apiReady
                ? 'Sends through the WhatsApp Business API with no one touching a phone.'
                : 'Needs a connected WhatsApp Business account. Set one up in Admin → Integrations.'}
            />
          </div>
        </div>

        {mode === 'api' && (
          <div>
            <label className="label">Approved template</label>
            <Select
              value={templateName}
              onChange={setTemplateName}
              placeholder="Free text (only works inside an open 24-hour window)"
              options={(templates ?? []).map((t) => ({
                value: String(t.name), label: `${String(t.name)} · ${String(t.status)}`,
              }))}
            />
            <p className="mt-1 text-2xs text-muted">
              Outside 24 hours of someone messaging you, Meta only delivers approved templates.
            </p>
          </div>
        )}

        {(mode === 'device' || !templateName) && (
          <div>
            <label className="label">Message</label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
            <p className="mt-1 text-2xs text-muted">
              {'{{first_name}}'} and {'{{name}}'} are filled in per person before sending.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ModeOption({
  selected, onSelect, title, detail, disabled,
}: { selected: boolean; onSelect: () => void; title: string; detail: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        selected ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40' : 'border-slate-200 dark:border-slate-800'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-brand-400'}`}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="text-2xs text-muted">{detail}</p>
    </button>
  );
}

function BroadcastDetail({ id, onClose }: { id: string; onClose: () => void }): JSX.Element {
  const { data } = useQuery({
    queryKey: ['broadcast', id],
    queryFn: () => api.broadcast_(id),
    refetchInterval: (query) => ((query.state.data as Broadcast | undefined)?.status === 'running' ? 2000 : false),
  });

  const grouped = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of data?.recipients ?? []) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }, [data]);

  return (
    <Modal open onClose={onClose} title={data?.name ?? 'Broadcast'} size="xl">
      {!data ? <Spinner className="mx-auto h-6 w-6" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {Object.entries(grouped).map(([status, count]) => (
              <Badge key={status} color={statusColour(status === 'sent' || status === 'handed_off' ? 'completed' : status)}>
                {count} {status.replace('_', ' ')}
              </Badge>
            ))}
          </div>

          <div className="max-h-96 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-2xs uppercase text-muted dark:bg-slate-900">
                <tr>
                  <th className="p-2">Name</th>
                  <th className="p-2">Number</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Why</th>
                </tr>
              </thead>
              <tbody>
                {data.recipients.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="p-2">{r.name ?? '—'}</td>
                    <td className="p-2 tnum text-muted">{r.handle.startsWith('no-number:') ? '—' : r.handle}</td>
                    <td className="p-2">{r.status.replace('_', ' ')}</td>
                    <td className="p-2 text-2xs text-muted">{r.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

function Sequences(): JSX.Element {
  const client = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<Sequence | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['sequences'], queryFn: () => api.sequences() });

  const create = useMutation({
    mutationFn: () => api.createSequence({ name: 'New follow-up sequence', moduleName: 'leads' }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['sequences'] });
      setEditing(result.id);
    },
    onError: (err: Error) => toast.error('Could not create the sequence', err.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.updateSequence(id, { isActive }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['sequences'] }),
    onError: (err: Error) => toast.error('Could not update the sequence', err.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSequence(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sequences'] });
      toast.success('Sequence deleted');
    },
    onError: (err: Error) => toast.error('Could not delete the sequence', err.message),
  });

  if (isLoading) return <Spinner className="mx-auto mt-8 h-6 w-6" />;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => create.mutate()} className="btn-primary text-sm">
          <Plus className="mr-1.5 h-4 w-4" /> New sequence
        </button>
      </div>

      {!data?.length && (
        <EmptyState
          icon={<Clock className="h-8 w-8" />}
          title="No sequences yet"
          body="A sequence follows up for you — day 1, day 3, day 7 — and stops the moment someone replies."
        />
      )}

      {data?.map((s) => (
        <Card key={s.id} className="p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <button onClick={() => setEditing(s.id)} className="text-left font-medium hover:underline">{s.name}</button>
              <p className="text-2xs text-muted">
                {s.step_count ?? 0} step{s.step_count === 1 ? '' : 's'} · {s.active_count ?? 0} active ·
                {' '}quiet {String(s.quiet_start).padStart(2, '0')}:00–{String(s.quiet_end).padStart(2, '0')}:00
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Toggle
                checked={s.is_active}
                onChange={(v) => toggle.mutate({ id: s.id, isActive: v })}
                ariaLabel={`${s.is_active ? 'Disable' : 'Enable'} ${s.name}`}
              />
              <button
                onClick={() => setConfirmDelete(s.id)}
                className="btn-ghost p-1.5 text-muted"
                aria-label={`Delete ${s.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => setEditing(s.id)} className="btn-secondary text-sm">Edit steps</button>
            <button
              onClick={() => setEnrolling(s)}
              disabled={!s.is_active || Number(s.step_count ?? 0) === 0}
              className="btn-primary text-sm"
              title={!s.is_active ? 'Switch the sequence on before enrolling people' : undefined}
            >
              <Users className="mr-1.5 h-3.5 w-3.5" /> Enrol leads
            </button>
          </div>
        </Card>
      ))}

      {editing && <SequenceEditor id={editing} onClose={() => setEditing(null)} />}
      {enrolling && <EnrolSequenceModal sequence={enrolling} onClose={() => setEnrolling(null)} />}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) remove.mutate(confirmDelete); setConfirmDelete(null); }}
        title="Delete this sequence?"
        body="Anyone part-way through it stops receiving messages. Messages already sent are not affected."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function EnrolSequenceModal({ sequence, onClose }: { sequence: Sequence; onClose: () => void }): JSX.Element {
  const client = useQueryClient();
  const [viewId, setViewId] = useState('');
  const { data: views } = useQuery({ queryKey: ['views', sequence.module_name], queryFn: () => api.views(sequence.module_name) });
  const { data: audience, isFetching } = useQuery({
    queryKey: ['sequence-audience', sequence.id, viewId],
    queryFn: () => api.list(sequence.module_name, { view: viewId, page: 1, pageSize: 1 }),
    enabled: Boolean(viewId),
  });
  const enrol = useMutation({
    mutationFn: () => api.enrolInSequence(sequence.id, { viewId }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['sequences'] });
      void client.invalidateQueries({ queryKey: ['sequence', sequence.id] });
      toast.success(
        `${result.enrolled} lead${result.enrolled === 1 ? '' : 's'} enrolled`,
        result.skipped.length ? `${result.skipped.length} skipped — already enrolled, opted out, or no number` : undefined,
      );
      onClose();
    },
    onError: (err: Error) => toast.error('Could not enrol this audience', err.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Enrol leads — ${sequence.name}`}
      size="md"
      footer={(
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => enrol.mutate()}
            disabled={!viewId || !audience?.total || enrol.isPending}
            className="btn-primary"
          >
            {enrol.isPending ? <Spinner className="h-4 w-4" /> : <Users className="h-4 w-4" />} Enrol
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        <div>
          <label className="label">Saved lead list</label>
          <Select
            value={viewId}
            onChange={setViewId}
            placeholder="Choose an audience…"
            options={(views ?? []).map((view) => ({ value: view.id, label: view.name }))}
          />
          {viewId && (
            <p className="mt-1 text-2xs text-muted">
              {isFetching ? 'Counting…' : `${audience?.total ?? 0} lead${audience?.total === 1 ? '' : 's'}`}
            </p>
          )}
        </div>
        <p className="text-xs text-muted">
          Opted-out leads and records without a WhatsApp number are skipped. Existing enrolments are never duplicated.
        </p>
      </div>
    </Modal>
  );
}

function SequenceEditor({ id, onClose }: { id: string; onClose: () => void }): JSX.Element {
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: ['sequence', id], queryFn: () => api.sequence(id) });

  const [name, setName] = useState('');
  const [quietStart, setQuietStart] = useState(21);
  const [quietEnd, setQuietEnd] = useState(9);
  const [steps, setSteps] = useState<Partial<SequenceStep>[]>([]);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setQuietStart(data.quiet_start);
    setQuietEnd(data.quiet_end);
    setSteps(data.steps.length ? data.steps : [{
      sequence: 1, delay_minutes: 60, channel: 'whatsapp',
      body: 'Hi {{first_name}}, following up on your enquiry — shall I send the floor plans?',
      fallback_to_device: true, is_active: true,
    }]);
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.updateSequence(id, { name, quietStart, quietEnd });
      await api.saveSequenceSteps(id, steps.map((s, i) => ({
        sequence: i + 1,
        delayMinutes: s.delay_minutes ?? 1440,
        channel: s.channel ?? 'whatsapp',
        templateName: s.template_name ?? null,
        subject: s.subject ?? null,
        body: s.body ?? '',
        buttons: s.buttons ?? [],
        fallbackToDevice: s.fallback_to_device ?? true,
        isActive: s.is_active ?? true,
      })));
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sequences'] });
      void client.invalidateQueries({ queryKey: ['sequence', id] });
      toast.success('Sequence saved');
      onClose();
    },
    onError: (err: Error) => toast.error('Could not save', err.message),
  });

  const update = (index: number, patch: Partial<SequenceStep>): void => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit sequence"
      size="xl"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Quiet hours start</label>
            <Select
              value={String(quietStart)}
              onChange={(v) => setQuietStart(Number(v))}
              options={hours()}
            />
          </div>
          <div>
            <label className="label">Quiet hours end</label>
            <Select value={String(quietEnd)} onChange={(v) => setQuietEnd(Number(v))} options={hours()} />
          </div>
        </div>
        <p className="-mt-2 text-2xs text-muted">
          Nothing sends between these times. A step that falls due is held until morning, not skipped.
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Steps</h3>
            <button
              onClick={() => setSteps((prev) => [...prev, {
                sequence: prev.length + 1, delay_minutes: 2880, channel: 'whatsapp',
                body: '', fallback_to_device: true, is_active: true,
              }])}
              className="btn-secondary text-sm"
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add step
            </button>
          </div>

          {steps.map((step, index) => (
            <Card key={index} className="space-y-3 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Step {index + 1}</span>
                <button
                  onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                  className="btn-ghost p-1 text-muted"
                  aria-label={`Remove step ${index + 1}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">Wait before sending</label>
                  <Select
                    value={String(step.delay_minutes ?? 1440)}
                    onChange={(v) => update(index, { delay_minutes: Number(v) })}
                    options={[
                      { value: '5', label: '5 minutes' },
                      { value: '60', label: '1 hour' },
                      { value: '360', label: '6 hours' },
                      { value: '1440', label: '1 day' },
                      { value: '2880', label: '2 days' },
                      { value: '4320', label: '3 days' },
                      { value: '10080', label: '1 week' },
                      { value: '20160', label: '2 weeks' },
                      { value: '43200', label: '1 month' },
                    ]}
                  />
                </div>
                <div>
                  <label className="label">Channel</label>
                  <Select
                    value={step.channel ?? 'whatsapp'}
                    onChange={(v) => update(index, { channel: v as SequenceStep['channel'] })}
                    options={[
                      { value: 'whatsapp', label: 'WhatsApp' },
                      { value: 'email', label: 'Email' },
                      { value: 'task', label: 'Task for the owner' },
                    ]}
                  />
                </div>
              </div>

              {step.channel === 'email' && (
                <div>
                  <label className="label">Subject</label>
                  <Input value={step.subject ?? ''} onChange={(e) => update(index, { subject: e.target.value })} />
                </div>
              )}

              <div>
                <label className="label">{step.channel === 'task' ? 'What to do' : 'Message'}</label>
                <Textarea
                  value={step.body ?? ''}
                  onChange={(e) => update(index, { body: e.target.value })}
                  rows={3}
                  placeholder="Hi {{first_name}}, …"
                />
              </div>

              {step.channel === 'whatsapp' && (
                <Toggle
                  checked={step.fallback_to_device ?? true}
                  onChange={(v) => update(index, { fallback_to_device: v })}
                  label="If it cannot send automatically, add it to my send queue"
                />
              )}
            </Card>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function hours(): { value: string; label: string }[] {
  return Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  }));
}

// ---------------------------------------------------------------------------
// Auto-replies
// ---------------------------------------------------------------------------

function AutoReplies(): JSX.Element {
  const client = useQueryClient();
  const [testText, setTestText] = useState('');
  const [editing, setEditing] = useState<AutoReplyRule | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['autoreply'], queryFn: () => api.autoReplyRules() });

  const { data: testResult, refetch: runTest, isFetching: testing } = useQuery({
    queryKey: ['autoreply-test', testText],
    queryFn: () => api.testAutoReply(testText),
    enabled: false,
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.updateAutoReplyRule(id, { isActive }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['autoreply'] }),
    onError: (err: Error) => toast.error('Could not update the rule', err.message),
  });

  if (isLoading) return <Spinner className="mx-auto mt-8 h-6 w-6" />;

  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-3">
        <h3 className="text-sm font-semibold">Try a message</h3>
        <p className="text-2xs text-muted">
          See which rule would answer, without messaging anyone.
        </p>
        <div className="flex gap-2">
          <Input
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="what is the price?"
            onKeyDown={(e) => { if (e.key === 'Enter') void runTest(); }}
          />
          <button onClick={() => void runTest()} disabled={!testText || testing} className="btn-secondary shrink-0">
            {testing ? '…' : 'Test'}
          </button>
        </div>
        {testResult && (
          <div className="rounded bg-slate-50 p-2 text-sm dark:bg-slate-900">
            {testResult.matched && testResult.rule ? (
              <>
                <p className="text-2xs font-medium text-muted">{testResult.rule.name}</p>
                <p className="mt-1 whitespace-pre-wrap">{testResult.rule.replyText}</p>
                {testResult.rule.buttons?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {testResult.rule.buttons.map((b) => (
                      <span key={b.id} className="rounded border border-slate-300 px-2 py-0.5 text-2xs dark:border-slate-700">
                        {b.title}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted">No rule matches — nothing would be sent.</p>
            )}
          </div>
        )}
      </Card>

      <div className="flex justify-end">
        <button
          onClick={() => setEditing({
            id: '', name: '', is_active: true, sequence: 100, trigger_type: 'keyword',
            match_type: 'contains', keywords: [], reply_text: '', buttons: [], button_routes: {},
            business_hours_only: false, handoff: false, media_url: null, is_routed_only: false, match_count: 0,
          })}
          className="btn-primary text-sm"
        >
          <Plus className="mr-1.5 h-4 w-4" /> New rule
        </button>
      </div>

      {data?.map((rule) => (
        <Card key={rule.id} className="p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <button onClick={() => setEditing(rule)} className="text-left font-medium hover:underline">
                {rule.name}
              </button>
              <p className="text-2xs text-muted">
                {rule.trigger_type === 'fallback' ? 'When nothing else matches'
                  : rule.trigger_type === 'welcome' ? 'On the first message in a new conversation'
                  : rule.is_routed_only ? 'Reached by a button'
                    : rule.keywords.join(', ') || 'No keywords'}
                {rule.match_count > 0 && ` · used ${rule.match_count}×`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {rule.handoff && <Badge color="#0891b2">hands over</Badge>}
              <Toggle
                checked={rule.is_active}
                onChange={(v) => toggle.mutate({ id: rule.id, isActive: v })}
                ariaLabel={`${rule.is_active ? 'Disable' : 'Enable'} ${rule.name}`}
              />
            </div>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-muted">{rule.reply_text}</p>
        </Card>
      ))}

      {editing && <RuleEditor rule={editing} allRules={data ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleEditor({
  rule, allRules, onClose,
}: { rule: AutoReplyRule; allRules: AutoReplyRule[]; onClose: () => void }): JSX.Element {
  const client = useQueryClient();
  const [draft, setDraft] = useState(rule);
  const [keywordText, setKeywordText] = useState(rule.keywords.join(', '));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: draft.name,
        isActive: draft.is_active,
        sequence: draft.sequence,
        triggerType: draft.trigger_type,
        matchType: draft.match_type,
        keywords: keywordText.split(',').map((k) => k.trim()).filter(Boolean),
        replyText: draft.reply_text,
        buttons: draft.buttons,
        buttonRoutes: draft.button_routes,
        businessHoursOnly: draft.business_hours_only,
        handoff: draft.handoff,
        isRoutedOnly: draft.is_routed_only,
      };
      return rule.id ? api.updateAutoReplyRule(rule.id, payload) : api.createAutoReplyRule(payload);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['autoreply'] });
      toast.success('Rule saved');
      onClose();
    },
    onError: (err: Error) => toast.error('Could not save', err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteAutoReplyRule(rule.id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['autoreply'] });
      onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={rule.id ? 'Edit rule' : 'New rule'}
      size="lg"
      footer={
        <>
          {rule.id && (
            <button onClick={() => remove.mutate()} className="btn-ghost mr-auto text-red-600">Delete</button>
          )}
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary">Save</button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Name</label>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Price enquiry"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Fires when</label>
            <Select
              value={draft.trigger_type}
              onChange={(v) => setDraft({ ...draft, trigger_type: v as AutoReplyRule['trigger_type'] })}
              options={[
                { value: 'keyword', label: 'A keyword appears' },
                { value: 'welcome', label: 'The first message arrives' },
                { value: 'fallback', label: 'Nothing else matched' },
              ]}
            />
          </div>
          <div>
            <label className="label">Order</label>
            <Input
              type="number"
              value={draft.sequence}
              onChange={(e) => setDraft({ ...draft, sequence: Number(e.target.value) })}
            />
          </div>
        </div>

        {draft.trigger_type === 'keyword' && (
          <>
            <div>
              <label className="label">Keywords</label>
              <Input
                value={keywordText}
                onChange={(e) => setKeywordText(e.target.value)}
                placeholder="price, rate, cost, kitna"
              />
              <p className="mt-1 text-2xs text-muted">Comma separated. Lower runs first; the first match wins.</p>
            </div>
            <Select
              value={draft.match_type}
              onChange={(v) => setDraft({ ...draft, match_type: v as 'contains' | 'exact' })}
              options={[
                { value: 'contains', label: 'Message contains the keyword' },
                { value: 'exact', label: 'Message is exactly the keyword' },
              ]}
            />
          </>
        )}

        <div>
          <label className="label">Reply</label>
          <Textarea
            value={draft.reply_text}
            onChange={(e) => setDraft({ ...draft, reply_text: e.target.value })}
            rows={4}
            placeholder="Hi {{first_name}}, …"
          />
        </div>

        <div>
          <label className="label">Quick-reply buttons</label>
          <p className="mb-2 text-2xs text-muted">
            Up to three. Each can hand off to another rule, which is how a two-step flow is built.
          </p>
          <div className="space-y-2">
            {draft.buttons.map((button, index) => (
              <div key={index} className="flex flex-wrap gap-2">
                <Input
                  value={button.title}
                  onChange={(e) => {
                    const buttons = [...draft.buttons];
                    buttons[index] = { ...button, title: e.target.value, id: button.id || slug(e.target.value) };
                    setDraft({ ...draft, buttons });
                  }}
                  placeholder="This weekend"
                  className="min-w-[8rem] flex-1"
                />
                <Select
                  value={draft.button_routes[button.id] ?? ''}
                  onChange={(v) => setDraft({
                    ...draft,
                    button_routes: { ...draft.button_routes, [button.id]: v },
                  })}
                  placeholder="Then reply with…"
                  options={allRules.filter((r) => r.id !== rule.id).map((r) => ({ value: r.id, label: r.name }))}
                  className="flex-1"
                />
                <button
                  onClick={() => setDraft({ ...draft, buttons: draft.buttons.filter((_, i) => i !== index) })}
                  className="btn-ghost p-2 text-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            {draft.buttons.length < 3 && (
              <button
                onClick={() => setDraft({ ...draft, buttons: [...draft.buttons, { id: `b${Date.now()}`, title: '' }] })}
                className="btn-secondary text-sm"
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add button
              </button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Toggle
            checked={draft.handoff}
            onChange={(v) => setDraft({ ...draft, handoff: v })}
            label="After this reply, hand the chat to a person and stop replying"
          />
          <Toggle
            checked={draft.business_hours_only}
            onChange={(v) => setDraft({ ...draft, business_hours_only: v })}
            label="Only during business hours"
          />
          <Toggle
            checked={draft.is_routed_only}
            onChange={(v) => setDraft({ ...draft, is_routed_only: v })}
            label="Only reachable from a button (never fires on keywords)"
          />
        </div>
      </div>
    </Modal>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || `b${Date.now()}`;
}
