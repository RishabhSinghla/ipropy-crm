import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  Mic, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Sparkles, TrendingUp,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn, renderMarkdown } from '../lib/utils';
import { Badge, EmptyState, Modal, ScoreChip, Select, Skeleton, Spinner } from '../components/ui';

interface Call {
  id: string; direction: string; from_number: string; to_number: string;
  status: string; duration_seconds: number; recording_url: string | null;
  disposition: string | null; notes: string | null; transcript?: string | null;
  ai_summary: string | null; ai_sentiment: string | null;
  ai_next_actions: string[] | null; ai_objections: string[] | null;
  ai_score: number | null; ai_talk_ratio: number | null;
  started_at: string; record_id: string | null; record_module: string | null;
  record_label: string | null; agent_name: string | null; source?: 'api' | 'device' | 'manual';
}

/**
 * What happened on the call.
 *
 * The single most valuable field in the whole telephony feature and the one
 * nobody fills in, because the only moment anyone will answer is right after
 * hanging up. So it is a prompt at the top of the page rather than a field
 * buried in a modal — and answering it *does* something: a call-back becomes a
 * task, "Do Not Call" sets the flag every other channel already respects.
 */
function DispositionPrompt(): JSX.Element | null {
  const client = useQueryClient();
  const [notes, setNotes] = useState('');
  const [followUp, setFollowUp] = useState('');

  const { data } = useQuery({
    queryKey: ['needs-disposition'],
    queryFn: () => api.callsNeedingDisposition(),
    refetchInterval: 60_000,
  });

  const { data: options } = useQuery({
    queryKey: ['picklist', 'call_disposition'],
    queryFn: () => api.picklist('call_disposition'),
    staleTime: 600_000,
  });

  const save = useMutation({
    mutationFn: ({ id, disposition }: { id: string; disposition: string }) =>
      api.setDisposition(id, {
        disposition,
        notes: notes || undefined,
        // "Call back later" without a date is a note nobody acts on; default to
        // tomorrow so the task is real, and let them change it on the task.
        followUpAt: disposition === 'Call Back Later'
          ? (followUp || new Date(Date.now() + 86_400_000).toISOString())
          : null,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['needs-disposition'] });
      void client.invalidateQueries({ queryKey: ['calls'] });
      setNotes('');
      setFollowUp('');
      toast.success('Logged');
    },
    onError: (err: Error) => toast.error('Could not save the outcome', err.message),
  });

  const call = (data ?? [])[0] as {
    id: string; to_number: string; from_number: string; direction: string;
    duration_seconds: number; record_id: string | null; record_module: string | null;
    record_label: string | null;
  } | undefined;
  if (!call) return null;

  const who = call.record_label ?? (call.direction === 'outbound' ? call.to_number : call.from_number);

  return (
    <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50/70 p-3 dark:border-brand-900 dark:bg-brand-950/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          How did the call with {who} go?
          <span className="ml-2 text-2xs font-normal text-muted tnum">
            {Math.round(call.duration_seconds / 60)} min · {relativeTime(String((call as { started_at?: string }).started_at ?? ''))}
          </span>
        </p>
        {(data?.length ?? 0) > 1 && (
          <span className="text-2xs text-muted">{(data?.length ?? 1) - 1} more waiting</span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {(options ?? []).map((option) => (
          <button
            key={option.value}
            onClick={() => save.mutate({ id: call.id, disposition: option.value })}
            disabled={save.isPending}
            className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium transition-colors hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            {option.label}
          </button>
        ))}
      </div>

      <input
        className="input mt-2 text-xs"
        placeholder="Anything worth remembering? (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
    </div>
  );
}

/** The same choice, inside the call detail, for anything missed at the time. */
function DispositionPicker({ call }: { call: Call }): JSX.Element {
  const client = useQueryClient();
  const [value, setValue] = useState(call.disposition ?? '');

  const { data: options } = useQuery({
    queryKey: ['picklist', 'call_disposition'],
    queryFn: () => api.picklist('call_disposition'),
    staleTime: 600_000,
  });

  const save = useMutation({
    mutationFn: (disposition: string) => api.setDisposition(call.id, { disposition }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['calls'] });
      void client.invalidateQueries({ queryKey: ['needs-disposition'] });
      toast.success('Outcome saved');
    },
  });

  return (
    <div>
      <label className="label">Outcome</label>
      <Select
        value={value}
        onChange={(v) => { setValue(v); save.mutate(v); }}
        placeholder="What happened?"
        options={(options ?? []).map((o) => ({ value: o.value, label: o.label }))}
      />
    </div>
  );
}

export default function CallsPage(): JSX.Element {
  const { user, telephonyAvailable } = useApp();
  const [direction, setDirection] = useState('');
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<Call | null>(null);
  const [showCoaching, setShowCoaching] = useState(false);

  const { data: calls, isLoading } = useQuery({
    queryKey: ['calls', direction, source],
    queryFn: () => api.calls({ direction: direction || undefined, source: source || undefined, limit: 60 }),
  });

  const { data: stats } = useQuery({
    queryKey: ['call-stats'],
    queryFn: () => api.callStats({ days: 7 }),
  });

  const list = (calls ?? []) as unknown as Call[];

  return (
    <div className="p-4 sm:p-6">
      <DispositionPrompt />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-950">
            <Phone className="h-4.5 w-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Calls</h1>
            <p className="text-xs text-muted">
              {telephonyAvailable
                ? 'Cloud click-to-call is active'
                : 'Phone dialling and Android call-log sync are available'}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Select
            value={source}
            onChange={setSource}
            placeholder="All sources"
            options={[
              { value: 'device', label: 'Phone sync' },
              { value: 'api', label: 'Cloud / API' },
              { value: 'manual', label: 'Manual' },
            ]}
            className="w-36 py-1.5 text-sm"
          />
          <Select
            value={direction}
            onChange={setDirection}
            placeholder="All calls"
            options={[
              { value: 'outbound', label: 'Outbound' },
              { value: 'inbound', label: 'Inbound' },
              { value: 'missed', label: 'Missed' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'blocked', label: 'Blocked' },
            ]}
            className="w-36 py-1.5 text-sm"
          />
          <button onClick={() => setShowCoaching(true)} className="btn-secondary btn-sm">
            <TrendingUp className="h-3.5 w-3.5" /> My coaching
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: 'Calls (7d)', value: stats.total_calls },
            { label: 'Connected', value: stats.connected },
            { label: 'Avg duration', value: `${Math.round(Number(stats.avg_duration ?? 0) / 60)}m` },
            { label: 'Talk time', value: `${Math.round(Number(stats.total_seconds ?? 0) / 3600)}h` },
            { label: 'Avg quality', value: stats.avg_quality ? `${stats.avg_quality}/100` : '—' },
          ].map((s) => (
            <div key={s.label} className="card p-3">
              <p className="text-2xs uppercase tracking-wide text-muted">{s.label}</p>
              <p className="mt-0.5 text-lg font-semibold tnum">{String(s.value ?? 0)}</p>
            </div>
          ))}
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Phone className="h-8 w-8" />} title="No calls yet" body="Calls placed from a record appear here with AI analysis." />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {list.map((call) => {
              const Icon = call.direction === 'inbound' ? PhoneIncoming
                : call.status !== 'completed' ? PhoneMissed : PhoneOutgoing;
              const failed = call.status !== 'completed';
              return (
                <li key={call.id}>
                  <button
                    onClick={() => setSelected(call)}
                    className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <span className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                      failed ? 'bg-red-100 text-red-600 dark:bg-red-950'
                        : call.direction === 'inbound' ? 'bg-emerald-100 text-positive dark:bg-emerald-950'
                        : 'bg-blue-100 text-blue-600 dark:bg-blue-950',
                    )}>
                      <Icon className="h-4 w-4" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-sm font-medium">
                          {call.record_label ?? (call.direction === 'inbound' ? call.from_number : call.to_number)}
                        </span>
                        {call.disposition && <Badge>{call.disposition}</Badge>}
                        {call.source === 'device' && <Badge color="#2563eb">phone sync</Badge>}
                        {call.source === 'manual' && <Badge color="#64748b">manual</Badge>}
                        {call.ai_sentiment && (
                          <Badge color={
                            call.ai_sentiment === 'positive' ? '#22c55e'
                              : call.ai_sentiment === 'negative' ? '#ef4444' : '#94a3b8'
                          }>
                            {call.ai_sentiment}
                          </Badge>
                        )}
                      </div>
                      {call.ai_summary && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted">{call.ai_summary}</p>
                      )}
                      <p className="mt-0.5 text-2xs text-muted tnum">
                        {call.agent_name} · {relativeTime(call.started_at)}
                        {call.duration_seconds > 0 && ` · ${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {call.ai_score !== null && <ScoreChip score={call.ai_score} />}
                      {call.recording_url && <Sparkles className="h-3.5 w-3.5 text-brand-400" />}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected && <CallModal call={selected} onClose={() => setSelected(null)} />}
      {showCoaching && user && <CoachingModal userId={user.id} onClose={() => setShowCoaching(false)} />}
    </div>
  );
}

function CallModal({ call, onClose }: { call: Call; onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const { aiAvailable } = useApp();
  const [transcript, setTranscript] = useState(call.transcript ?? '');
  const [analysing, setAnalysing] = useState(false);

  const { data: detail } = useQuery({
    queryKey: ['call', call.id],
    queryFn: () => api.callDetail(call.id),
  });

  const full = (detail ?? call) as unknown as Call;

  const analyse = async (): Promise<void> => {
    setAnalysing(true);
    try {
      await api.analyseCall(call.id, transcript || undefined);
      toast.success('Call analysed');
      void queryClient.invalidateQueries({ queryKey: ['call', call.id] });
      void queryClient.invalidateQueries({ queryKey: ['calls'] });
    } catch (err) {
      toast.error('Analysis failed', (err as Error).message);
    } finally {
      setAnalysing(false);
    }
  };

  const [transcribing, setTranscribing] = useState(false);
  const transcribe = async (): Promise<void> => {
    setTranscribing(true);
    try {
      const { transcript: text } = await api.transcribeCall(call.id);
      setTranscript(text);
      toast.success('Recording transcribed');
    } catch (err) {
      toast.error('Transcription failed', (err as Error).message);
    } finally {
      setTranscribing(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Call with ${full.record_label ?? full.to_number}`}
      size="lg"
      footer={
        full.record_id && full.record_module ? (
          <Link to={`/${full.record_module}/${full.record_id}`} className="btn-secondary">Open record</Link>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {[
            { label: 'Direction', value: full.direction },
            { label: 'Status', value: full.status.replace(/_/g, ' ') },
            { label: 'Duration', value: `${Math.floor(full.duration_seconds / 60)}m ${full.duration_seconds % 60}s` },
            { label: 'Agent', value: full.agent_name ?? '—' },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-2xs uppercase tracking-wide text-muted">{item.label}</p>
              <p className="mt-0.5 text-sm font-medium capitalize">{item.value}</p>
            </div>
          ))}
        </div>

        {full.recording_url && (
          <div>
            <p className="label">Recording</p>
            {/* Streamed through the API, which range-serves it so scrubbing a
                ten-minute call does not re-download from the start. `<audio>`
                cannot send an Authorization header, hence the token in the URL. */}
            <audio controls preload="metadata" src={api.recordingUrl(full.id)} className="w-full" />
          </div>
        )}

        <DispositionPicker call={full} />

        {full.ai_summary && (
          <div className="rounded-lg border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-900 dark:bg-brand-950/30">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-brand-500" />
              <p className="text-xs font-medium">AI analysis</p>
              {full.ai_score !== null && <ScoreChip score={full.ai_score} />}
              {full.ai_talk_ratio !== null && (
                <span className="text-2xs text-muted tnum">Agent talk ratio {full.ai_talk_ratio}%</span>
              )}
            </div>
            <p className="text-sm text-slate-700 dark:text-slate-300">{full.ai_summary}</p>

            {full.ai_objections?.length ? (
              <div className="mt-2">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted">Objections</p>
                <ul className="mt-0.5 list-inside list-disc text-xs text-muted">
                  {full.ai_objections.map((o, i) => <li key={i}>{o}</li>)}
                </ul>
              </div>
            ) : null}

            {full.ai_next_actions?.length ? (
              <div className="mt-2">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted">Next actions</p>
                <ul className="mt-0.5 list-inside list-disc text-xs text-muted">
                  {full.ai_next_actions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        )}

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label className="label mb-0">Transcript</label>
            <div className="flex items-center gap-1.5">
              {full.recording_url && (
                <button onClick={() => void transcribe()} disabled={transcribing || Boolean(full.transcript)} className="btn-secondary btn-sm">
                  {transcribing ? <Spinner className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
                  {full.transcript ? 'Transcribed' : 'Transcribe recording'}
                </button>
              )}
              {aiAvailable && (
                <button onClick={() => void analyse()} disabled={analysing || !transcript.trim()} className="btn-secondary btn-sm">
                  {analysing ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3 text-brand-500" />}
                  {full.ai_summary ? 'Re-analyse' : 'Analyse with AI'}
                </button>
              )}
            </div>
          </div>
          <textarea
            className="input font-mono text-xs"
            rows={8}
            placeholder="Paste or type the call transcript here to run AI analysis…"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
          <p className="mt-1 text-2xs text-muted">
            Transcripts arrive automatically when your provider supplies them; otherwise transcribe the recording or paste one here.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function CoachingModal({ userId, onClose }: { userId: string; onClose: () => void }): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['coaching', userId],
    queryFn: () => api.coaching(userId),
    retry: false,
  });

  const report = data as { summary: string; strengths: string[]; improvements: string[]; metrics: Record<string, number> } | undefined;

  return (
    <Modal open onClose={onClose} title="Call coaching report" size="md">
      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : error || !report ? (
        <EmptyState
          icon={<TrendingUp className="h-8 w-8" />}
          title="Not enough data yet"
          body="Analyse at least three calls to generate a coaching report."
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(report.metrics).map(([key, value]) => (
              <div key={key} className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-700">
                <p className="text-2xs uppercase tracking-wide text-muted">
                  {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                </p>
                <p className="mt-0.5 text-base font-semibold tnum">{value}</p>
              </div>
            ))}
          </div>

          <div className="prose-ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(report.summary) }} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
              <p className="mb-1 text-xs font-medium text-emerald-800 dark:text-emerald-300">Strengths</p>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-emerald-700 dark:text-emerald-400">
                {report.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
              <p className="mb-1 text-xs font-medium text-amber-800 dark:text-amber-300">Focus areas</p>
              <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-700 dark:text-amber-400">
                {report.improvements.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
