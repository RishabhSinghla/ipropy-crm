/**
 * Which phones the CRM can reach, and which it cannot.
 *
 * **20 September 2026, the owner:** *"please set a system also, so that we can
 * see the phone is synced, ideal or offline"* — after pressing Call and being
 * told, afterwards, that his phone had not picked it up.
 *
 * The honest answer needs three different facts, because a phone can fail in
 * three different ways and they look identical from a desk:
 *
 *  * **Is the app open?** A desk Call travels over the app's own connection,
 *    so a closed app cannot be rung however healthy the handset is. This is
 *    the one that decides whether pressing Call will work, and it is new —
 *    the app now says so every minute while it is open.
 *  * **When did it last send calls?** The background worker only contacts the
 *    CRM when there are new calls to upload, so this standing still is normal
 *    on a quiet morning and alarming after a busy one.
 *  * **How did the last Call end?** "expired" means the phone never collected
 *    the instruction, which is the exact failure the owner keeps meeting.
 *
 * One component, used by a rep looking at their own handset in Settings and by
 * an admin looking at the team's. The list endpoint already decides who sees
 * whose — a rep gets their own rows.
 */
import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PhoneOff, Smartphone, Wifi } from 'lucide-react';
import { relativeTime } from '@ipropy/shared';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { reachability, type PhoneRow, type Reachability } from '../lib/phoneStatus';
import { Badge, Skeleton } from './ui';

const LOOK: Record<Reachability, { label: string; colour: string; hint: string }> = {
  open: {
    label: 'App open',
    colour: '#16a34a',
    hint: 'Pressing Call in the CRM will ring this phone now.',
  },
  idle: {
    label: 'Idle',
    colour: '#f59e0b',
    hint: 'The phone has been in touch today, but the app is not open — a Call will not reach it until somebody opens it.',
  },
  offline: {
    label: 'Offline',
    colour: '#dc2626',
    hint: 'Nothing has been heard from this phone for over twelve hours.',
  },
  never: {
    label: 'Never seen',
    colour: '#dc2626',
    hint: 'This phone paired but has never contacted the CRM. Open the app on it and sign in.',
  },
};

export function PhoneStatus({ compact = false }: { compact?: boolean }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.devices(),
    // A status page that ages while somebody watches it is worse than none.
    refetchInterval: 30_000,
  });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  const phones = ((data ?? []) as unknown as PhoneRow[]).filter((phone) => phone.is_active);
  if (!phones.length) {
    return (
      <p className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-muted dark:border-slate-700">
        No phone is paired yet. Install the app on the handset, sign in, then turn on call logging.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {phones.map((phone) => {
        const state = reachability(phone);
        const look = LOOK[state];
        return (
          <article key={phone.id} className={cn('card flex flex-wrap items-center gap-3', compact ? 'p-3' : 'p-4')}>
            <span className="shrink-0">
              {state === 'open'
                ? <Wifi className="h-5 w-5" style={{ color: look.colour }} />
                : state === 'idle'
                  ? <Smartphone className="h-5 w-5" style={{ color: look.colour }} />
                  : <PhoneOff className="h-5 w-5" style={{ color: look.colour }} />}
            </span>

            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {phone.user_name ?? 'Unassigned'}
                <Badge color={look.colour}>{look.label}</Badge>
                {phone.app_version
                  ? <span className="text-2xs font-normal text-muted">app {phone.app_version}</span>
                  : <span className="text-2xs font-normal text-muted">an older app</span>}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted">
                {phone.label}
                {phone.last_sync_at
                  ? ` · last sent calls ${relativeTime(phone.last_sync_at)}`
                  : ' · has never sent a call'}
                {phone.last_dial_status && phone.last_dial_at
                  ? ` · last Call ${relativeTime(phone.last_dial_at)}: ${dialWord(phone.last_dial_status)}`
                  : ''}
              </p>
            </div>

            <p className="w-full text-xs text-muted sm:w-auto sm:max-w-sm">{look.hint}</p>
          </article>
        );
      })}
    </div>
  );
}

/** The command's own word, in one a person can act on. */
function dialWord(status: string): string {
  if (status === 'done') return 'the phone rang';
  if (status === 'expired') return 'the phone never picked it up';
  if (status === 'queued' || status === 'delivered') return 'waiting for the phone';
  if (status === 'failed') return 'the phone could not place it';
  return status;
}
