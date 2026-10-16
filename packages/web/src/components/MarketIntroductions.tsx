/**
 * The call sheet: a buyer in one dealer group, a seller in another, and why they fit.
 * These are the introductions nobody else can make, because the two of them are in
 * rooms that never overlap.
 *
 * Each side is one property, shown as its own few lines; the whole message it came
 * from is one click away. The CRM only suggests; a person rings both. What they did
 * about it is kept (called, meeting, won, lost, not for us) so the list shrinks as work
 * gets done — and "not a real match" is its own answer, because that one teaches the
 * matcher and is never shown again.
 */
import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatIndianPrice } from '@ipropy/shared';
import { Phone } from 'lucide-react';
import { api, type MarketDealSide, type MarketIntroduction, type MarketIntroductionStatus } from '../lib/api';
import DealMessageDialog, { type MessageToShow } from './DealMessageDialog';
import { Badge, EmptyState, Spinner } from './ui';
import { toast } from '../lib/store';

const ACTIONS: Array<{ status: MarketIntroductionStatus; label: string }> = [
  { status: 'called', label: 'Called' },
  { status: 'meeting', label: 'Meeting fixed' },
  { status: 'won', label: 'Won' },
  { status: 'lost', label: 'Lost' },
  { status: 'dismissed', label: 'Not for us' },
  { status: 'bad_match', label: 'Not a real match' },
];

const STATUS_LABEL: Record<MarketIntroductionStatus, string> = {
  new: 'New', called: 'Called', meeting: 'Meeting fixed', won: 'Won', lost: 'Lost', dismissed: 'Not for us', bad_match: 'Not a real match',
};

function placeText(key: string): string {
  if (key.includes(':')) return key.replace(/^(.*?):block (.)$/, (_m, project: string, block: string) => `${project.toUpperCase()} · Block ${block}`);
  const sector = /^sector (\d+)([a-z]?)$/.exec(key);
  return sector ? `Sector ${sector[1]}${sector[2]!.toUpperCase()}` : key.replace(/\b\w/g, (c) => c.toUpperCase());
}

function facts(side: MarketDealSide): string {
  const parts: string[] = [];
  if (side.sizeSqYd) parts.push(`${side.sizeSqYd} yd`);
  if (side.bhk) parts.push(`${side.bhk} BHK`);
  if (side.category) parts.push(side.category);
  if (side.priceMinLakh !== null) parts.push(`${formatIndianPrice(side.priceMinLakh * 100_000)}${side.purpose === 'rent' ? ' / month' : ''}`);
  return parts.join(' · ');
}

function Side({ title, side, onOpen }: { title: string; side: MarketDealSide; onOpen: (message: MessageToShow) => void }): JSX.Element {
  const open = (): void => onOpen({
    postId: side.postId, body: side.body, posterName: side.posterName, posterPhone: side.posterPhone,
    groups: side.groups, postedAt: side.postedAt, highlight: side.summary,
  });
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      <p className="text-sm font-semibold">{side.posterName ?? 'Unknown sender'}</p>
      <p className="text-xs text-muted">{side.groups.join(', ')}</p>
      {facts(side) && <p className="text-xs">{facts(side)}</p>}
      {side.placeKeys.length > 0 && <p className="flex flex-wrap gap-1">{side.placeKeys.slice(0, 4).map((key) => <Badge key={key}>{placeText(key)}</Badge>)}</p>}
      <button type="button" onClick={open} className="block w-full text-left" aria-label={`Read the full message from ${side.posterName ?? 'this dealer'}`}>
        <span className="line-clamp-3 whitespace-pre-wrap text-xs text-muted">{side.summary || side.body}</span>
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={open} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">Read full message</button>
        {side.posterPhone && (
          <a href={`tel:${side.posterPhone}`} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">
            <Phone className="h-3.5 w-3.5" /> {side.posterPhone}
          </a>
        )}
      </div>
    </div>
  );
}

function Introduction({ match, onOpen, onDone }: { match: MarketIntroduction; onOpen: (message: MessageToShow) => void; onDone: () => void }): JSX.Element {
  const mark = useMutation({
    mutationFn: (status: MarketIntroductionStatus) => api.setMarketIntroduction(match.want.id, match.have.id, status),
    onSuccess: onDone,
    onError: (err) => toast.error('Could not save that', (err as Error).message),
  });
  // Jev's read of whether the offer answers the requirement is the number to trust; the rules' score
  // saturates at 100% for almost any pair of the right area, type and size.
  const jev = match.jevFit;
  const sure = jev !== null && jev >= 0.7;
  return (
    <li className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {jev !== null
          ? <Badge color={sure ? '#16a34a' : '#d97706'}>{sure ? 'Sure-shot' : 'Possible'} · Jev {Math.round(jev * 100)}%</Badge>
          : <Badge color="#64748b">Not checked by Jev yet</Badge>}
        {match.crossGroup && <Badge>Different groups</Badge>}
        {match.status !== 'new' && <Badge color="#2563eb">{STATUS_LABEL[match.status]}</Badge>}
        <span className="text-muted">Rules fit {Math.round(match.score * 100)}% · {match.reasons.join(' · ')}</span>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <Side title={match.want.purpose === 'rent' ? 'Tenant' : 'Buyer'} side={match.want} onOpen={onOpen} />
        <Side title={match.have.purpose === 'rent' ? 'Landlord' : 'Seller'} side={match.have} onOpen={onOpen} />
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
  const [message, setMessage] = useState<MessageToShow | null>(null);
  const sureShot = minScore >= 0.8;
  const query = { crossGroupOnly, minScore: sureShot ? 0.7 : minScore, includeWorked, sureShot };
  const [refreshing, setRefreshing] = useState(false);
  // Jev checks the new pairings in the background; give it a moment, then look again.
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await api.refreshMarket();
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await queryClient.invalidateQueries({ queryKey: ['market', 'introductions'] });
    } catch (err) {
      toast.error('Could not refresh', (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const { data, isLoading, error } = useQuery({ queryKey: ['market', 'introductions', query], queryFn: () => api.marketIntroductions(query) });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        A buyer in one group who fits a seller in another, property by property. Ring both, fix a meeting, and mark what happened — the list gets shorter as you work.
        If a pairing is wrong, say so: it will not come back.
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
          <option value={0.8}>Sure-shot (strong, and Jev agrees)</option>
        </select>
        <button type="button" className="btn-secondary" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
      {error && <p className="text-sm text-negative">Could not load the introductions: {(error as Error).message}</p>}
      {data && (data.length === 0 ? (
        <EmptyState title="Nothing to ring about yet" body="Introductions appear once groups with both buyers and sellers are added. A property needs a sector or a named area to be matched." />
      ) : (
        <ul className="space-y-3">
          {[...data].sort((a, b) => (b.jevFit ?? -1) - (a.jevFit ?? -1) || b.score - a.score).map((match) => (
            <Introduction key={match.id} match={match} onOpen={setMessage} onDone={() => void queryClient.invalidateQueries({ queryKey: ['market', 'introductions'] })} />
          ))}
        </ul>
      ))}
      <DealMessageDialog message={message} onClose={() => setMessage(null)} />
    </div>
  );
}
