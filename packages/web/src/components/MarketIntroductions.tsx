/**
 * The call sheet: a buyer in one dealer group, a seller in another, and why
 * they fit. These are the introductions nobody else can make, because the two
 * of them are in rooms that never overlap.
 *
 * The CRM only suggests; a person rings both. What they did about it is kept
 * (called, meeting, won, lost, not for us) so the list shrinks as work gets
 * done and a won deal is a fact somebody can count later.
 */
import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatIndianPrice } from '@ipropy/shared';
import { Phone } from 'lucide-react';
import { api, type MarketDealSide, type MarketIntroduction, type MarketIntroductionStatus } from '../lib/api';
import { Badge, EmptyState, Spinner } from './ui';
import { toast } from '../lib/store';

const ACTIONS: Array<{ status: MarketIntroductionStatus; label: string }> = [
  { status: 'called', label: 'Called' },
  { status: 'meeting', label: 'Meeting fixed' },
  { status: 'won', label: 'Won' },
  { status: 'lost', label: 'Lost' },
  { status: 'dismissed', label: 'Not for us' },
];

const STATUS_LABEL: Record<MarketIntroductionStatus, string> = {
  new: 'New', called: 'Called', meeting: 'Meeting fixed', won: 'Won', lost: 'Lost', dismissed: 'Not for us',
};

function facts(side: MarketDealSide): string {
  const parts: string[] = [];
  if (side.sizeSqYd) parts.push(`${side.sizeSqYd} yd`);
  if (side.bhk) parts.push(`${side.bhk} BHK`);
  if (side.category) parts.push(side.category);
  if (side.priceMinLakh !== null) parts.push(formatIndianPrice(side.priceMinLakh * 100_000));
  return parts.join(' · ');
}

function Side({ title, side }: { title: string; side: MarketDealSide }): JSX.Element {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      <p className="text-sm font-semibold">{side.posterName ?? 'Unknown sender'}</p>
      <p className="text-xs text-muted">{side.groups.join(', ')}</p>
      {facts(side) && <p className="text-xs">{facts(side)}</p>}
      <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted">{side.body}</p>
      {side.posterPhone && (
        <a href={`tel:${side.posterPhone}`} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
          <Phone className="h-3.5 w-3.5" /> {side.posterPhone}
        </a>
      )}
    </div>
  );
}

function Introduction({ match, onDone }: { match: MarketIntroduction; onDone: () => void }): JSX.Element {
  const mark = useMutation({
    mutationFn: (status: MarketIntroductionStatus) => api.setMarketIntroduction(match.want.id, match.have.id, status),
    onSuccess: onDone,
    onError: (err) => toast.error('Could not save that', (err as Error).message),
  });
  const strong = match.score >= 0.7;
  return (
    <li className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge color={strong ? '#16a34a' : '#d97706'}>{strong ? 'Strong' : 'Possible'} · {Math.round(match.score * 100)}%</Badge>
        {match.crossGroup && <Badge>Different groups</Badge>}
        {match.status !== 'new' && <Badge color="#2563eb">{STATUS_LABEL[match.status]}</Badge>}
        <span className="text-muted">{match.reasons.join(' · ')}</span>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <Side title="Buyer" side={match.want} />
        <Side title="Seller" side={match.have} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-2">
        {ACTIONS.map((action) => (
          <button
            key={action.status}
            type="button"
            className={match.status === action.status ? 'btn-primary' : 'btn-secondary'}
            disabled={mark.isPending}
            onClick={() => mark.mutate(action.status)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </li>
  );
}

export default function MarketIntroductions(): JSX.Element {
  const queryClient = useQueryClient();
  const [crossGroupOnly, setCrossGroupOnly] = useState(true);
  const [minScore, setMinScore] = useState(0.5);
  const [includeWorked, setIncludeWorked] = useState(false);
  const query = { crossGroupOnly, minScore, includeWorked };
  const { data, isLoading, error } = useQuery({ queryKey: ['market', 'introductions', query], queryFn: () => api.marketIntroductions(query) });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        A buyer in one group who fits a seller in another. Ring both, fix a meeting, and mark what happened — the list gets shorter as you work.
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={crossGroupOnly} onChange={(e) => setCrossGroupOnly(e.target.checked)} /> Only people in different groups
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={includeWorked} onChange={(e) => setIncludeWorked(e.target.checked)} /> Show finished ones
        </label>
        <select className="input w-auto" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} aria-label="How good a fit">
          <option value={0.5}>Possible and strong</option>
          <option value={0.7}>Strong only</option>
        </select>
      </div>
      {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
      {error && <p className="text-sm text-negative">Could not load the introductions: {(error as Error).message}</p>}
      {data && (data.length === 0 ? (
        <EmptyState title="Nothing to ring about yet" body="Introductions appear once groups with both buyers and sellers are added. A post needs a sector or locality to be matched." />
      ) : (
        <ul className="space-y-3">
          {data.map((match) => (
            <Introduction key={`${match.want.id}:${match.have.id}`} match={match} onDone={() => void queryClient.invalidateQueries({ queryKey: ['market', 'introductions'] })} />
          ))}
        </ul>
      ))}
    </div>
  );
}
