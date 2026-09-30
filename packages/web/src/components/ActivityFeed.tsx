/**
 * What happened to this customer, read like a WhatsApp chat.
 *
 * **30 September 2026, the owner's prototype:** the middle pane is the
 * conversation — the day in a chip down the middle, the customer's messages
 * on the left, ours on the right in green, calls as small cards you can play,
 * and every change to the record as a quiet line between them. The notes box
 * sits under it (`NoteComposer`, look `dock`), so writing about what is on
 * screen never means leaving it.
 *
 * It reads the same timeline the record page always has (`api.timeline`), so
 * nothing about *what* happened is decided here — only how it looks. Oldest at
 * the top and newest at the bottom, the way every chat reads, and it opens
 * scrolled to the newest.
 */
import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { relativeTime, type TimelineEntry } from '@ipropy/shared';
import { Activity, Check, CheckCheck, Lock, Mail, Paperclip, PhoneIncoming, PhoneMissed, PhoneOutgoing, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { Avatar, Skeleton } from './ui';

/** The chips above the stream. `all` asks the server for every kind at once. */
const FEED_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'comment', label: 'Notes' },
  { key: 'message', label: 'Messages' },
  { key: 'call', label: 'Calls' },
  { key: 'audit', label: 'Changes' },
  { key: 'attachment', label: 'Files' },
] as const;
type FeedFilter = typeof FEED_FILTERS[number]['key'];

/** The server's page of history. More than this reads as "60+" on the tab. */
export const FEED_LIMIT = 60;

/** The same question the tab badge asks, so the badge and the stream share one request. */
export function useActivityEntries(module: string, recordId: string, filter: FeedFilter = 'all') {
  return useQuery({
    queryKey: ['timeline', module, recordId, filter],
    queryFn: () => api.timeline(module, recordId, filter === 'all' ? undefined : [filter]),
    enabled: Boolean(recordId),
    staleTime: 15_000,
  });
}

export function ActivityFeed({ module, recordId, customerName, find = '' }: {
  module: string;
  recordId: string;
  /** Initials on the customer's own bubbles. */
  customerName: string;
  /** Words typed into the header's search: only entries that mention them. */
  find?: string;
}): JSX.Element {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const { data, isLoading, isError, refetch } = useActivityEntries(module, recordId, filter);
  const entries = useMemo(() => {
    const needle = find.trim().toLocaleLowerCase();
    return [...(data ?? [])]
      .filter((entry) => !needle || `${entry.title} ${entry.body ?? ''} ${entry.actorName ?? ''}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [data, find]);

  // Open on the newest, the way a chat does — and stay there when a note is posted.
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [entries.length, recordId, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="activity-feed">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-white px-3 py-1.5 no-scrollbar dark:bg-slate-900" role="group" aria-label="Show in the timeline">
        {FEED_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={filter === option.key}
            onClick={() => setFilter(option.key)}
            className={cn(
              'shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors',
              filter === option.key
                ? 'bg-brand-600 text-white'
                : 'text-slate-600 hover:bg-[var(--surface-muted)] dark:text-slate-300 dark:hover:bg-slate-800',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* Focusable, so the stream can be scrolled from the keyboard — a region
          that scrolls and cannot be reached is one a keyboard user cannot read. */}
      <div className="workspace-activity-canvas min-h-0 flex-1 space-y-3 overflow-y-auto p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400" tabIndex={0} role="log" aria-label="Activity">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-14 w-2/3" />)
        ) : isError ? (
          <SystemLine>
            Could not load the timeline.{' '}
            <button type="button" className="font-semibold underline" onClick={() => void refetch()}>Try again</button>
          </SystemLine>
        ) : entries.length === 0 ? (
          <div className="py-16 text-center">
            <Activity className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{find.trim() ? `Nothing mentions “${find.trim()}”` : 'Nothing here yet'}</p>
            <p className="mt-1 text-xs text-muted">{find.trim() ? 'Try other words, or clear the search above.' : 'Notes, messages, calls and changes to this record appear here.'}</p>
          </div>
        ) : (
          entries.map((entry, index) => (
            <div key={entry.id}>
              {!sameDay(entry.at, entries[index - 1]?.at) && <DayChip at={entry.at} />}
              <FeedItem entry={entry} customerName={customerName} />
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function FeedItem({ entry, customerName }: { entry: TimelineEntry; customerName: string }): JSX.Element {
  const time = clock(entry.at);
  switch (entry.type) {
    case 'message':
    case 'email': {
      const inbound = entry.meta.direction === 'inbound';
      const status = String(entry.meta.status ?? '');
      return (
        <Bubble
          side={inbound ? 'left' : 'right'}
          tone={inbound ? 'in' : 'out'}
          who={inbound ? customerName : entry.actorName}
          time={time}
          ticks={inbound ? null : status === 'read' ? 'read' : status === 'delivered' ? 'delivered' : 'sent'}
          label={entry.type === 'email' ? <><Mail className="h-3 w-3" /> {entry.title}</> : null}
        >
          {entry.body || entry.title}
        </Bubble>
      );
    }
    case 'comment':
      return (
        <Bubble side="right" tone="note" who={entry.actorName} time={time} label={<><Lock className="h-3 w-3" /> Internal note</>}>
          {entry.body || entry.title}
        </Bubble>
      );
    case 'call':
      return <CallCard entry={entry} time={time} />;
    case 'attachment':
      return (
        <Bubble side="left" tone="in" who={entry.actorName} time={time} label={<><Paperclip className="h-3 w-3" /> File</>}>
          {entry.body || entry.title}
        </Bubble>
      );
    default:
      return (
        <SystemLine>
          <RefreshCw className="h-3 w-3 shrink-0 text-brand-600" />
          <span>
            {entry.body ? <><strong>{entry.title}</strong> · {entry.body}</> : <strong>{entry.title}</strong>}
            {entry.actorName && <> by <strong>{entry.actorName}</strong></>}
            <span className="ml-1 text-muted">· {time}</span>
          </span>
        </SystemLine>
      );
  }
}

function Bubble({ side, tone, who, time, ticks = null, label, children }: {
  side: 'left' | 'right';
  tone: 'in' | 'out' | 'note';
  who: string | null;
  time: string;
  ticks?: 'sent' | 'delivered' | 'read' | null;
  label?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn('flex items-end gap-2', side === 'right' ? 'justify-end' : 'justify-start')}>
      {side === 'left' && <Avatar name={who ?? '?'} size={28} className="shrink-0" />}
      <div className={cn(
        'min-w-0 max-w-[34rem] rounded-2xl border p-2.5 text-xs text-slate-800 shadow-xs dark:text-slate-100',
        side === 'left' ? 'rounded-bl-none' : 'rounded-br-none',
        tone === 'in' && 'border-slate-200/70 bg-white dark:border-slate-700 dark:bg-slate-800',
        // WhatsApp's own "sent" green, which is what makes the stream read as a chat.
        tone === 'out' && 'border-emerald-200/80 bg-[#d9fdd3] dark:border-emerald-900 dark:bg-emerald-950',
        tone === 'note' && 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950',
      )}>
        {(label || (tone !== 'in' && who)) && (
          <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
            {label}
            {tone !== 'in' && who && <span className="truncate">{label ? '· ' : ''}{who}</span>}
          </p>
        )}
        {/* `break-words`: a long number or link with no spaces would otherwise run off the bubble. */}
        <p className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{children}</p>
        <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-500 dark:text-slate-400">
          {time}
          {ticks === 'sent' && <Check className="h-3 w-3" aria-label="Sent" />}
          {ticks === 'delivered' && <CheckCheck className="h-3 w-3" aria-label="Delivered" />}
          {ticks === 'read' && <CheckCheck className="h-3 w-3 text-sky-600" aria-label="Read" />}
        </p>
      </div>
    </div>
  );
}

/** A call as a small centred card, with its recording when there is one. */
function CallCard({ entry, time }: { entry: TimelineEntry; time: string }): JSX.Element {
  const direction = String(entry.meta.direction ?? '');
  const Icon = direction === 'missed' ? PhoneMissed : direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
  const callId = typeof entry.meta.callId === 'string' ? entry.meta.callId : null;
  const hasRecording = Boolean(entry.meta.recordingUrl) && callId;
  return (
    <div className="mx-auto max-w-md rounded-xl border border-indigo-100 bg-white p-2.5 shadow-xs dark:border-indigo-900 dark:bg-slate-800">
      <div className="flex items-center gap-3">
        <span className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          direction === 'missed' ? 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-300' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300',
        )}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-bold text-slate-800 dark:text-slate-100">{entry.title}</span>
          {entry.body && <span className="block truncate text-[11px] text-slate-600 dark:text-slate-300">{entry.body}</span>}
        </span>
        <span className="shrink-0 text-[10px] text-slate-500 dark:text-slate-400">{time}</span>
      </div>
      {/* Loaded only when somebody presses play — a day of recordings is megabytes. */}
      {hasRecording && <audio className="mt-2 h-8 w-full" controls preload="none" src={api.recordingUrl(callId!)} />}
    </div>
  );
}

function SystemLine({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex justify-center">
      <p className="flex max-w-[90%] items-center gap-1.5 rounded-md border border-slate-300 bg-slate-100 px-3 py-1 text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
        {children}
      </p>
    </div>
  );
}

function DayChip({ at }: { at: string }): JSX.Element {
  return (
    <div className="my-2 flex justify-center">
      <span className="rounded-full border border-slate-200 bg-white px-3 py-0.5 text-[11px] font-semibold text-slate-600 shadow-2xs dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        {new Date(at).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </span>
    </div>
  );
}

/** Calendar days in this browser's own time, never hours elapsed — 11pm and 1am are two days. */
function sameDay(a: string, b: string | undefined): boolean {
  if (!b) return false;
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function clock(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return relativeTime(at);
  return when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}
