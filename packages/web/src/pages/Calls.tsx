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
import { CallDonut } from '../components/CallDonut';

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

/** A date as YYYY-MM-DD on this computer's own calendar, not UTC's. */
function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today, the Monday of this week and the first of this month. */
function boundaries(now = new Date()): { today: string; week: string; month: string } {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return {
    today: localDay(now),
    week: localDay(monday),
    month: localDay(new Date(now.getFullYear(), now.getMonth(), 1)),
  };
}

/** The day before a YYYY-MM-DD date, because the list's `to` includes the day it names. */
function dayBefore(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return localDay(date);
}

/*
  The first three are the ones somebody asks for daily and overlap on purpose
  ("this week" includes today). The last three are the When chart's own
  slices, which do not — clicking "Earlier this week" shows exactly the calls
  that slice counted.
*/
const RANGES = [
  { key: '', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'earlier-week', label: 'Earlier this week' },
  { key: 'earlier-month', label: 'Earlier this month' },
  { key: 'before-month', label: 'Before this month' },
] as const;

function rangeDates(range: string): { from?: string; to?: string } {
  const day = boundaries();
  switch (range) {
    case 'today': return { from: day.today };
    case 'week': return { from: day.week };
    case 'month': return { from: day.month };
    case 'earlier-week': return { from: day.week, to: dayBefore(day.today) };
    case 'earlier-month': return { from: day.month, to: dayBefore(day.week < day.month ? day.today : day.week) };
    // When this week began last month, those days belong to "earlier this
    // week" in the chart, so they are left out here too.
    case 'before-month': return { to: dayBefore(day.week < day.month ? day.week : day.month) };
    default: return {};
  }
}

/** The When chart's slices, mapped onto the ranges above. */
const WHEN_SLICE_TO_RANGE: Record<string, string> = {
  today: 'today', week: 'earlier-week', month: 'earlier-month', earlier: 'before-month',
};

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
  // Whose calls: '' is everybody the viewer may see.
  const [agent, setAgent] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);

  const { data: agentList } = useQuery({ queryKey: ['call-agents'], queryFn: () => api.callAgents() });

  /** Every filter except the paging, shared by the list and the charts. */
  const filters = useMemo(() => ({
    ...(direction ? { direction } : {}),
    ...(answered ? { answered } : {}),
    ...(disposition ? { disposition } : {}),
    ...rangeDates(range),
    ...(agent ? { userId: agent } : {}),
  }), [direction, answered, disposition, range, agent]);
  const params = useMemo(() => ({ limit: 100, ...filters }), [filters]);

  const { data, isLoading } = useQuery({
    queryKey: ['calls', params],
    queryFn: () => api.callsWithTotal(params),
  });
  /*
    Each chart leaves its own filter out, so choosing "Outgoing" does not turn
    the direction donut into one solid ring — it keeps showing the whole split
    with Outgoing picked out, while the other two charts narrow to it.
  */
  const without = (key: 'direction' | 'answered' | 'range'): Record<string, unknown> => {
    const rest: Record<string, unknown> = {
      ...(disposition ? { disposition } : {}),
      ...(agent ? { userId: agent } : {}),
      ...boundaries(),
    };
    if (key !== 'direction' && direction) rest.direction = direction;
    if (key !== 'answered' && answered) rest.answered = answered;
    if (key !== 'range') Object.assign(rest, rangeDates(range));
    return rest;
  };
  const byDirection = useQuery({ queryKey: ['calls-breakdown', 'direction', without('direction')], queryFn: () => api.callsBreakdown(without('direction')) });
  const byAnswered = useQuery({ queryKey: ['calls-breakdown', 'answered', without('answered')], queryFn: () => api.callsBreakdown(without('answered')) });
  const byWhen = useQuery({ queryKey: ['calls-breakdown', 'when', without('range')], queryFn: () => api.callsBreakdown(without('range')) });
  const count = (list: { key: string; count: number }[] | undefined, key: string): number =>
    list?.find((slice) => slice.key === key)?.count ?? 0;
  const whenSelected = Object.entries(WHEN_SLICE_TO_RANGE).find(([, value]) => value === range)?.[0] ?? '';

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
        <label>
          <span className="label">Agent</span>
          <select
            className="input w-auto"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            aria-label="Agent"
          >
            {/* Somebody who may only see their own calls gets their own name, and no choice. */}
            {agentList?.canSeeAll !== false && <option value="">All agents</option>}
            {(agentList?.agents ?? []).map((person) => (
              <option key={person.id} value={person.id}>{person.id === user?.id ? `${person.name} (me)` : person.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <CallDonut
          title="Direction"
          selected={direction}
          onSelect={setDirection}
          slices={[
            { key: 'outbound', label: 'Outgoing', count: count(byDirection.data?.direction, 'outbound') },
            { key: 'inbound', label: 'Incoming', count: count(byDirection.data?.direction, 'inbound') },
            { key: 'missed', label: 'Missed', count: count(byDirection.data?.direction, 'missed') },
            { key: 'other', label: 'Other', count: count(byDirection.data?.direction, 'other'), selectable: false },
          ]}
        />
        <CallDonut
          title="Picked up"
          selected={answered}
          onSelect={setAnswered}
          slices={[
            { key: 'yes', label: 'Answered', count: count(byAnswered.data?.answered, 'yes') },
            { key: 'no', label: 'Not answered', count: count(byAnswered.data?.answered, 'no') },
          ]}
        />
        <CallDonut
          title="When"
          selected={whenSelected}
          onSelect={(key) => setRange(key ? WHEN_SLICE_TO_RANGE[key] ?? '' : '')}
          slices={[
            { key: 'today', label: 'Today', count: count(byWhen.data?.when, 'today') },
            { key: 'week', label: 'Earlier this week', count: count(byWhen.data?.when, 'week') },
            { key: 'month', label: 'Earlier this month', count: count(byWhen.data?.when, 'month') },
            { key: 'earlier', label: 'Before this month', count: count(byWhen.data?.when, 'earlier') },
          ]}
        />
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

              {/* Always a labelled column, so a row with no talk time says so
                  rather than leaving a gap that reads as missing data. */}
              <span className="w-32 shrink-0 whitespace-nowrap text-xs tabular-nums" title="How long the call lasted">
                <span className="text-muted">Duration </span>
                <span className="font-semibold text-slate-800 dark:text-slate-100">{formatDuration(call.duration_seconds)}</span>
              </span>
              <span className="shrink-0 text-xs text-muted" title={new Date(call.started_at).toLocaleString('en-IN')}>
                {relativeTime(call.started_at)}
              </span>

              {/* Loaded only when somebody presses play: a hundred <audio>
                  elements each fetch their own metadata on render. */}
              {call.recording_url ? (
                playing === call.id
                  ? <audio src={api.recordingUrl(call.id)} controls autoPlay className="h-8 w-56 shrink-0" />
                  : (
                    <button className="btn-secondary btn-sm w-28 shrink-0 justify-center" onClick={() => setPlaying(call.id)}>
                      <Play className="h-3.5 w-3.5" /> Recording
                    </button>
                  )
              ) : (
                <span className="w-28 shrink-0 text-center text-xs text-muted" title="No recording reached the CRM for this call">
                  No recording
                </span>
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
  if (!seconds) return '0s';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}
