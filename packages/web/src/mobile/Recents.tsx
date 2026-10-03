/**
 * The call log, with the CRM in it — the prototype's second screen.
 *
 * A phone's own recents list says a name and a time. This one says which lead,
 * which unit, what stage they are at and what the last person who rang them
 * wrote down, because that is the difference between a dialler and a broker's
 * dialler.
 *
 * **Nothing here re-derives a call.** It is `GET /api/telephony/calls`, the
 * same endpoint the Calls page and the record's Calls tab read, so a call
 * cannot read one way on a laptop and another on a phone. The filters are the
 * endpoint's own.
 */
import { type JSX, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  MessageSquare, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Search, SquarePen,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { relativeTime } from '@ipropy/shared';
import { Avatar } from './primitives';
import { useBottomBarHeight } from './useBottomBarHeight';

/**
 * The three questions a rep asks of a call log, as the prototype's chips.
 *
 * The parameter names are the endpoint's own: `answered` takes `yes`/`no`, and
 * "only mine" is a `userId` rather than a flag — there is no `mine`. Guessing
 * either sends a filter the server ignores, so the chip lights up and the list
 * does not move, which reads as a broken filter rather than a wrong parameter.
 */
const FILTERS = [
  { key: 'all', label: 'All calls' },
  { key: 'missed', label: 'Missed' },
  { key: 'mine', label: 'Only mine' },
] as const;

type FilterKey = typeof FILTERS[number]['key'];

/**
 * What kind of call this was, as an icon and a word.
 *
 * Missed is the one that gets its own red: it is the only row on this screen
 * that is a thing still to do, and the prototype marks it as such. The other
 * two are history.
 */
function kindOf(call: Record<string, unknown>): { label: string; tone: string; icon: JSX.Element } {
  const incoming = String(call.direction ?? '') === 'inbound';
  /*
    **`status`, not an `answered` flag** — the row has no such field, which a
    browser found and no test could: every call read as answered and the whole
    log drew in one colour. `ipy_call.status` is `completed` or `no_answer`.
  */
  /*
    **Time on the clock is what "answered" means**, which is the server's own
    rule and is written down beside its filter: a status word is whatever that
    make of handset chose to call it, and reading one here would give a
    different answer on a Samsung and a Xiaomi for the same call.
  */
  const answered = Number(call.duration_seconds ?? 0) > 0;
  if (incoming && !answered) {
    return { label: 'Missed call', tone: 'text-[#dc2626]', icon: <PhoneMissed className="h-3.5 w-3.5" /> };
  }
  if (incoming) {
    return { label: 'Incoming', tone: 'text-[#15803d]', icon: <PhoneIncoming className="h-3.5 w-3.5" /> };
  }
  return { label: 'Outgoing', tone: 'text-[#2563eb]', icon: <PhoneOutgoing className="h-3.5 w-3.5" /> };
}

/** `04:12 mins`, the way the prototype prints a duration. */
function spokenFor(seconds: unknown): string | null {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return null;
  const minutes = Math.floor(total / 60);
  const rest = Math.floor(total % 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')} mins`;
}

export default function MobileRecents(): JSX.Element {
  const navigate = useNavigate();
  const measureBottomBar = useBottomBarHeight<HTMLDivElement>();
  const [filter, setFilter] = useState<FilterKey>('all');
  const { user } = useApp();

  const query = filter === 'missed'
    ? { answered: 'no' }
    : filter === 'mine' && user?.id ? { userId: user.id } : {};

  const { data: calls = [], isLoading } = useQuery({
    // `limit`, not `pageSize` — the endpoint's own word for it.
    queryKey: ['mobile-recents', filter, user?.id],
    queryFn: () => api.calls({ ...query, limit: 50 }),
    staleTime: 15_000,
  });

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]" data-testid="mobile-recents">
      <div className="shrink-0 px-4 pb-2 pt-3">
        <button
          type="button"
          onClick={() => navigate('/calls')}
          className="flex w-full items-center gap-3 rounded-full border border-[var(--border)] bg-white px-4 py-3 text-left text-sm text-slate-500 shadow-2xs dark:bg-slate-900"
        >
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="truncate">Search calls, leads, properties…</span>
        </button>
      </div>

      {/* The chips. Horizontally scrollable rather than wrapped: a second row
          of filters pushes the first call off a phone's screen. */}
      <div className="shrink-0 overflow-x-auto px-4 pb-2">
        <div className="flex w-max gap-2">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={filter === entry.key}
              onClick={() => setFilter(entry.key)}
              className={cn(
                'shrink-0 rounded-full border px-4 py-2 text-xs font-semibold transition-colors',
                filter === entry.key
                  ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                  : 'border-[var(--border)] bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={measureBottomBar} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-6">
        {isLoading && <p className="py-10 text-center text-sm text-muted">Loading your calls…</p>}
        {!isLoading && calls.length === 0 && (
          <p className="py-10 text-center text-sm text-muted">No calls to show yet.</p>
        )}

        {calls.map((call) => {
          const kind = kindOf(call);
          /*
            The endpoint answers the table's own columns, in snake_case. Read
            as camelCase every row said "Unknown number" with no time against
            it — correct code reading fields that have never existed, which is
            only ever visible on a screen.
          */
          const outbound = String(call.direction ?? '') !== 'inbound';
          const number = String((outbound ? call.to_number : call.from_number) ?? '');
          const name = String(call.record_label ?? number ?? 'Unknown number');
          const recordId = call.record_id ? String(call.record_id) : null;
          const module = String(call.record_module ?? 'leads');
          const duration = spokenFor(call.duration_seconds);
          const note = call.notes ? String(call.notes) : '';
          const missed = kind.label === 'Missed call';

          return (
            <div
              key={String(call.id)}
              data-testid="recent-call"
              className={cn(
                'rounded-2xl border bg-white p-3 shadow-2xs dark:bg-slate-900',
                /* A missed call is the only row that is still a job to do, so
                   it is the only one the card itself marks. */
                missed ? 'border-[#fca5a5]' : 'border-[var(--border)]',
              )}
            >
              <button
                type="button"
                onClick={() => recordId && navigate(`/${module}/${recordId}`)}
                className="flex w-full items-center gap-3 text-left"
              >
                <Avatar name={name} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold text-slate-900 dark:text-white">{name}</span>
                  <span className={cn('mt-0.5 flex items-center gap-1.5 text-xs font-medium', kind.tone)}>
                    {kind.icon}
                    {kind.label}
                    <span className="text-slate-400">•</span>
                    <span className="truncate font-normal text-slate-500">
                      {call.started_at ? relativeTime(String(call.started_at)) : ''}
                      {duration ? ` • ${duration}` : ''}
                    </span>
                  </span>
                </span>
              </button>

              {/* What the last person who rang them wrote. The prototype puts
                  it in its own recessed block, and it is the one thing here a
                  phone's own call log can never show. */}
              {note && (
                <p className="mt-2 rounded-xl bg-[var(--surface-muted)] p-2.5 text-xs italic text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  “{note}”
                </p>
              )}

              <div className="mt-2.5 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => (recordId
                    ? navigate(`/${module}/${recordId}?dial=1`)
                    : navigate(`/dialer?to=${encodeURIComponent(number)}`))}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[11px] font-semibold text-white',
                    missed ? 'bg-[#dc2626]' : 'bg-[#16a34a]',
                  )}
                >
                  <Phone className="h-3.5 w-3.5" />
                  {missed ? 'Return call' : 'Call back'}
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/chats?to=${encodeURIComponent(number)}`)}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#86efac] bg-[#f0fdf4] px-3 py-2 text-[11px] font-semibold text-[#15803d]"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  WhatsApp
                </button>
                {recordId && (
                  <button
                    type="button"
                    onClick={() => navigate(`/${module}/${recordId}`)}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 dark:bg-slate-900 dark:text-slate-300"
                  >
                    <SquarePen className="h-3.5 w-3.5" />
                    Add note
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
