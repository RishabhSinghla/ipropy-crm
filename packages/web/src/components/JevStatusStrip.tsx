/**
 * Jev at a glance, beside the sort: is it connected, how many pairings it has rated, how many wait, how many it is
 * working on this second, and what today has cost. The three states a pairing can be in are named here and on each card
 * the same way — Rated, Waiting for Jev, and (rarely) Could not read — so "checking" and "not checked yet" stop meaning
 * the same thing.
 */
import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { relativeTime } from '@ipropy/shared';

export function useJevStatus() {
  return useQuery({
    queryKey: ['market', 'jev-status'],
    queryFn: api.marketJevStatus,
    staleTime: 4_000,
    // Quick while it is working so the numbers move; slow once it has nothing left to do.
    refetchInterval: (query) => ((query.state.data?.pairings.waiting ?? 0) > 0 || (query.state.data?.pairings.checkingNow ?? 0) > 0 ? 5_000 : 30_000),
  });
}

const money = (usd: number): string => (usd < 0.01 ? 'under 1¢' : `$${usd.toFixed(2)}`);

export default function JevStatusStrip(): JSX.Element | null {
  const { data, error } = useJevStatus();
  if (error) return <p className="text-xs text-negative">Could not read Jev's status: {(error as Error).message}</p>;
  if (!data) return null;
  const { connection, pairings, today, week } = data;
  const share = pairings.total ? Math.round((pairings.rated / pairings.total) * 100) : 0;
  const working = pairings.checkingNow > 0;
  const state = !connection.connected
    ? { dot: 'bg-red-500', text: 'Jev is not connected', hint: 'Add a TypeSafe key under Admin → Integrations → Jev, or the OpenRouter key.' }
    : working ? { dot: 'bg-amber-500 animate-pulse', text: `Jev is checking ${pairings.checkingNow} now`, hint: '' }
      : pairings.waiting > 0 ? { dot: 'bg-amber-500', text: 'Jev is working through the rest', hint: '' }
        : { dot: 'bg-green-600', text: 'Jev has rated everything', hint: '' };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs" data-testid="jev-status" aria-live="polite">
      <span className="inline-flex items-center gap-1.5 font-semibold" title={state.hint || `${connection.via === 'typesafe' ? 'Directly through TypeSafe' : 'Through OpenRouter'} · ${connection.model ?? ''}`}>
        <span className={`h-2 w-2 rounded-full ${state.dot}`} aria-hidden="true" /> {state.text}
      </span>
      {connection.connected && (
        <>
          <span className="inline-flex items-center gap-2" title="Pairings on the call sheet that Jev has rated">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--border)]" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
              <span className="block h-full rounded-full bg-green-600" style={{ width: `${share}%` }} />
            </span>
            <strong>{pairings.rated.toLocaleString('en-IN')}</strong> rated of {pairings.total.toLocaleString('en-IN')}
          </span>
          <span><strong>{pairings.waiting.toLocaleString('en-IN')}</strong> waiting for Jev</span>
          {pairings.gaveUp > 0 && <span title="Jev could not read these after three tries; they are left alone.">{pairings.gaveUp} could not be read</span>}
          <span title={`${data.messages.read.toLocaleString('en-IN')} messages read, ${data.messages.waiting} waiting`}>
            <strong>{pairings.sure.toLocaleString('en-IN')}</strong> sure-shots
          </span>
          <span className="ml-auto text-muted" title={`This week: ${week.calls.toLocaleString('en-IN')} questions, about ${money(week.costUsd)}. TypeSafe charges $0.042 per million input tokens.`}>
            Today {today.calls.toLocaleString('en-IN')} questions · about {money(today.costUsd)}{today.failed ? ` · ${today.failed} failed` : ''}
          </span>
          {connection.lastError && Date.now() - new Date(connection.lastError.at).getTime() < 3_600_000 && (
            <span className="text-negative" title={connection.lastError.message}>last problem {relativeTime(connection.lastError.at)}</span>
          )}
        </>
      )}
    </div>
  );
}
