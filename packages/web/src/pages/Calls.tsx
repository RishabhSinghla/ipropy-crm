/**
 * Every call the CRM knows about, in one place.
 *
 * Calls already appear on the record they belong to and in its timeline. What
 * was missing is the other question — *what did the team do today* — which is
 * not a question about one customer and cannot be answered from a record page.
 *
 * Nothing here re-derives a call. The rows come from `/api/telephony/calls`,
 * which is the same endpoint the record's own Calls tab reads and the same one
 * the phone's sync writes into, and it decides who may see whose: a rep sees
 * their own unless their profile says otherwise.
 */
import { type JSX, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Play } from 'lucide-react';
import { relativeTime } from '@ipropy/shared';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useCallDispositions } from '../lib/callDispositions';
import { cn } from '../lib/utils';
import { Avatar, EmptyState, Skeleton } from '../components/ui';

const DIRECTIONS = [
  { key: '', label: 'All calls' },
  { key: 'outbound', label: 'Outgoing' },
  { key: 'inbound', label: 'Incoming' },
  { key: 'missed', label: 'Missed' },
] as const;

const ANSWERED = [
  { key: '', label: 'Answered or not' },
  { key: 'yes', label: 'Answered' },
  { key: 'no', label: 'Not answered' },
] as const;

/** Today, and the first of this month — the two ranges somebody asks for daily. */
function startOf(kind: 'today' | 'week' | 'month'): string {
  const now = new Date();
  if (kind === 'today') return now.toISOString().slice(0, 10);
  if (kind === 'week') {
    const day = (now.getDay() + 6) % 7;
    return new Date(now.getTime() - day * 86_400_000).toISOString().slice(0, 10);
  }
  return `${now.toISOString().slice(0, 7)}-01`;
}

const RANGES = [
  { key: '', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
] as const;

interface CallRow {
  id: string;
  direction: string;
  from_number: string;
  to_number: string;
  duration_seconds: number;
  disposition: string | null;
  notes: string | null;
  recording_url: string | null;
  started_at: string;
  source: string;
  record_id: string | null;
  record_module: string | null;
  record_label: string | null;
  agent_name: string | null;
  user_id: string | null;
}

export default function Calls(): JSX.Element {
  const { user } = useApp();
  const dispositions = useCallDispositions();
  const [direction, setDirection] = useState('');
  const [answered, setAnswered] = useState('');
  const [disposition, setDisposition] = useState('');
  const [range, setRange] = useState('');
  const [mine, setMine] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const params = useMemo(() => ({
    limit: 100,
    ...(direction ? { direction } : {}),
    ...(answered ? { answered } : {}),
    ...(disposition ? { disposition } : {}),
    ...(range ? { from: startOf(range as 'today' | 'week' | 'month') } : {}),
    ...(mine && user ? { userId: user.id } : {}),
  }), [direction, answered, disposition, range, mine, user]);

  const { data, isLoading } = useQuery({
    queryKey: ['calls', params],
    queryFn: () => api.callsWithTotal(params),
  });

  const calls = (data?.calls ?? []) as unknown as CallRow[];
  const talkTime = calls.reduce((sum, call) => sum + (call.duration_seconds || 0), 0);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Calls</h1>
        <p className="text-sm text-muted">
          {isLoading ? 'Counting…' : (
            <>
              {(data?.total ?? 0).toLocaleString('en-IN')} calls · {formatDuration(talkTime)} on this page
            </>
          )}
        </p>
      </div>

      <div className="card flex flex-wrap items-end gap-2 p-3">
        <Picker label="Direction" value={direction} onChange={setDirection} options={DIRECTIONS} />
        <Picker label="Picked up" value={answered} onChange={setAnswered} options={ANSWERED} />
        <label>
          <span className="label">Outcome</span>
          <select className="input w-auto" value={disposition} onChange={(e) => setDisposition(e.target.value)}>
            <option value="">Any outcome</option>
            {dispositions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <Picker label="When" value={range} onChange={setRange} options={RANGES} />
        <label className="flex items-center gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-0"
          />
          <span className="text-sm">Only mine</span>
        </label>
      </div>

      {isLoading ? <Skeleton className="h-64 w-full" /> : !calls.length ? (
        <EmptyState title="No calls here" body="Nothing matches these filters yet." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {calls.map((call) => (
            <article key={call.id} className="flex flex-wrap items-center gap-3 p-3">
              <span className="shrink-0" title={call.direction}>
                <DirectionIcon direction={call.direction} answered={call.duration_seconds > 0} />
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {call.record_id && call.record_module ? (
                    <Link to={`/${call.record_module}/${call.record_id}`} className="hover:underline">
                      {call.record_label ?? 'Open record'}
                    </Link>
                  ) : (
                    <span className="text-muted">Unknown number</span>
                  )}
                </p>
                <p className="truncate text-xs text-muted tnum">
                  {call.direction === 'inbound' ? call.from_number : call.to_number}
                  {call.disposition ? ` · ${call.disposition}` : ''}
                  {call.notes ? ` · ${call.notes}` : ''}
                </p>
              </div>

              {call.agent_name && (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
                  <Avatar name={call.agent_name} size={18} className="text-[9px]" />
                  {call.agent_name}
                </span>
              )}

              <span className="shrink-0 text-xs tabular-nums text-muted">
                {formatDuration(call.duration_seconds)}
              </span>
              <span className="shrink-0 text-xs text-muted" title={new Date(call.started_at).toLocaleString('en-IN')}>
                {relativeTime(call.started_at)}
              </span>

              {/* Loaded only when somebody presses play: a hundred <audio>
                  elements each fetch their own metadata on render. */}
              {call.recording_url && (
                playing === call.id
                  ? <audio src={api.recordingUrl(call.id)} controls autoPlay className="h-8 w-56 shrink-0" />
                  : (
                    <button className="btn-secondary btn-sm shrink-0" onClick={() => setPlaying(call.id)}>
                      <Play className="h-3.5 w-3.5" /> Recording
                    </button>
                  )
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Picker({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { key: string; label: string }[];
}): JSX.Element {
  return (
    <label>
      <span className="label">{label}</span>
      <select className="input w-auto" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
    </label>
  );
}

/** Missed is a direction on a handset and an outcome to a person; both read here. */
function DirectionIcon({ direction, answered }: { direction: string; answered: boolean }): JSX.Element {
  if (direction === 'missed' || (direction === 'inbound' && !answered)) {
    return <PhoneMissed className="h-4 w-4 text-red-500" />;
  }
  if (direction === 'inbound') return <PhoneIncoming className="h-4 w-4 text-emerald-600" />;
  if (direction === 'outbound') return <PhoneOutgoing className="h-4 w-4 text-blue-600" />;
  return <PhoneCall className="h-4 w-4 text-slate-400" />;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}
