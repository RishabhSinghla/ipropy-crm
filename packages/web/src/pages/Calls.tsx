import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Sparkles, TrendingUp,
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
  record_label: string | null; agent_name: string | null;
}

export default function CallsPage(): JSX.Element {
  const { user, telephonyAvailable } = useApp();
  const [direction, setDirection] = useState('');
  const [selected, setSelected] = useState<Call | null>(null);
  const [showCoaching, setShowCoaching] = useState(false);

  const { data: calls, isLoading } = useQuery({
    queryKey: ['calls', direction],
    queryFn: () => api.calls({ direction: direction || undefined, limit: 60 }),
  });

  const { data: stats } = useQuery({
    queryKey: ['call-stats'],
    queryFn: () => api.callStats({ days: 7 }),
  });

  const list = (calls ?? []) as unknown as Call[];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-950">
            <Phone className="h-4.5 w-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Calls</h1>
            <p className="text-xs text-slate-500">
              {telephonyAvailable ? 'Click-to-call is active' : 'No telephony provider configured — logs only'}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Select
            value={direction}
            onChange={setDirection}
            placeholder="All calls"
            options={[
              { value: 'outbound', label: 'Outbound' },
              { value: 'inbound', label: 'Inbound' },
              { value: 'missed', label: 'Missed' },
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
              <p className="text-2xs uppercase tracking-wide text-slate-400">{s.label}</p>
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
                        : call.direction === 'inbound' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950'
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
                        <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{call.ai_summary}</p>
                      )}
                      <p className="mt-0.5 text-2xs text-slate-400 tnum">
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
              <p className="text-2xs uppercase tracking-wide text-slate-400">{item.label}</p>
              <p className="mt-0.5 text-sm font-medium capitalize">{item.value}</p>
            </div>
          ))}
        </div>

        {full.recording_url && (
          <div>
            <p className="label">Recording</p>
            <audio controls src={full.recording_url} className="w-full" />
          </div>
        )}

        {full.ai_summary && (
          <div className="rounded-lg border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-900 dark:bg-brand-950/30">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-brand-500" />
              <p className="text-xs font-medium">AI analysis</p>
              {full.ai_score !== null && <ScoreChip score={full.ai_score} />}
              {full.ai_talk_ratio !== null && (
                <span className="text-2xs text-slate-500 tnum">Agent talk ratio {full.ai_talk_ratio}%</span>
              )}
            </div>
            <p className="text-sm text-slate-700 dark:text-slate-300">{full.ai_summary}</p>

            {full.ai_objections?.length ? (
              <div className="mt-2">
                <p className="text-2xs font-medium uppercase tracking-wide text-slate-500">Objections</p>
                <ul className="mt-0.5 list-inside list-disc text-xs text-slate-600 dark:text-slate-400">
                  {full.ai_objections.map((o, i) => <li key={i}>{o}</li>)}
                </ul>
              </div>
            ) : null}

            {full.ai_next_actions?.length ? (
              <div className="mt-2">
                <p className="text-2xs font-medium uppercase tracking-wide text-slate-500">Next actions</p>
                <ul className="mt-0.5 list-inside list-disc text-xs text-slate-600 dark:text-slate-400">
                  {full.ai_next_actions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="label mb-0">Transcript</label>
            {aiAvailable && (
              <button onClick={() => void analyse()} disabled={analysing || !transcript.trim()} className="btn-secondary btn-sm">
                {analysing ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3 text-brand-500" />}
                {full.ai_summary ? 'Re-analyse' : 'Analyse with AI'}
              </button>
            )}
          </div>
          <textarea
            className="input font-mono text-xs"
            rows={8}
            placeholder="Paste or type the call transcript here to run AI analysis…"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
          <p className="mt-1 text-2xs text-slate-400">
            Transcripts arrive automatically when your provider supplies them; otherwise paste one here.
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
                <p className="text-2xs uppercase tracking-wide text-slate-400">
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
