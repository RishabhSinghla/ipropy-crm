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
import { type JSX, useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatIndianPrice } from '@ipropy/shared';
import { ChevronLeft, ChevronRight, Phone } from 'lucide-react';
import { api, type MarketDealSide, type MarketIntroduction, type MarketIntroductionSort, type MarketIntroductionStatus } from '../lib/api';
import DealMessageDialog, { type MessageToShow } from './DealMessageDialog';
import { Badge, EmptyState, Spinner } from './ui';
import { toast } from '../lib/store';

/**
 * The six answers. The first four are work in progress: the pairing stays where it is, the button fills with a colour (white text on each clears AA),
 * and pressing it again takes the answer back. The last two put the pairing away for good — "not a real match" also
 * teaches the matcher and Jev — so they ask for no colour and leave a line with one way back, for this visit only.
 */
const ACTIONS: Array<{ status: MarketIntroductionStatus; label: string; keeps: boolean; colours?: { background: string; color: string; borderColor: string } }> = [
  { status: 'called', label: 'Called', keeps: true, colours: { background: '#4e45d5', color: '#ffffff', borderColor: '#4e45d5' } },
  { status: 'meeting', label: 'Meeting fixed', keeps: true, colours: { background: '#b45309', color: '#ffffff', borderColor: '#b45309' } },
  { status: 'won', label: 'Won', keeps: true, colours: { background: '#15803d', color: '#ffffff', borderColor: '#15803d' } },
  { status: 'lost', label: 'Lost', keeps: true, colours: { background: '#b91c1c', color: '#ffffff', borderColor: '#b91c1c' } },
  { status: 'dismissed', label: 'Not for us', keeps: false },
  { status: 'bad_match', label: 'Not a real match', keeps: false },
];

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<MarketIntroductionStatus, string> = {
  new: 'New', called: 'Called', meeting: 'Meeting fixed', won: 'Won', lost: 'Lost', dismissed: 'Not for us', bad_match: 'Not a real match',
};

/** The kinds of property the feed tells apart, as the reader names them. */
const TYPES = ['Residential Plot', 'Builder Floor', 'Apartment', 'Kothi/Villa', 'Commercial Plot', 'Office Space', 'Factory'];

const SORTS: Array<{ id: MarketIntroductionSort; label: string }> = [
  { id: 'best', label: 'Latest & most matching' },
  { id: 'match', label: 'Most matching' },
  { id: 'newest', label: 'Newest first' },
];

/** Typing in a box should not ask the server a question for every key. */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How old a posting is, in the words a dealer would use. Never says "in the future": that was a misread date. */
function ageText(postedAt: string | null): string | null {
  if (!postedAt) return null;
  const days = Math.floor((Date.now() - new Date(postedAt).getTime()) / 86_400_000);
  if (days <= 0) return 'Posted today';
  return days === 1 ? 'Posted yesterday' : `Posted ${days} days ago`;
}

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
      {ageText(side.postedAt) && <p className="text-xs text-muted">{ageText(side.postedAt)}</p>}
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

function Introduction({ match, onOpen }: { match: MarketIntroduction; onOpen: (message: MessageToShow) => void }): JSX.Element {
  // What is shown is the answer the server last accepted, so a click changes the screen at once and a refused one changes it back.
  const [status, setStatus] = useState<MarketIntroductionStatus>(match.status);
  useEffect(() => setStatus(match.status), [match.status]);
  const mark = useMutation({
    mutationFn: (next: MarketIntroductionStatus) => api.setMarketIntroduction(match.want.id, match.have.id, next),
    onMutate: (next) => { const before = status; setStatus(next); return { before }; },
    onError: (err, _next, context) => {
      if (context) setStatus(context.before);
      toast.error('Could not save that', (err as Error).message);
    },
  });
  const choose = (action: (typeof ACTIONS)[number]): void => mark.mutate(action.keeps && status === action.status ? 'new' : action.status);

  if (status === 'dismissed' || status === 'bad_match') {
    return (
      <li className="card flex flex-wrap items-center gap-3 p-3 text-sm text-muted">
        <span>
          {status === 'bad_match' ? 'Marked not a real match — it will not come back, and the matcher learns from it.' : 'Marked not for us — it will not come back.'}
        </span>
        <button type="button" className="btn-secondary" disabled={mark.isPending} onClick={() => mark.mutate('new')}>Undo</button>
      </li>
    );
  }

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
        <span className="text-muted">Rules fit {Math.round(match.score * 100)}% · {match.reasons.join(' · ')}</span>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <Side title={match.want.purpose === 'rent' ? 'Tenant' : 'Buyer'} side={match.want} onOpen={onOpen} />
        <Side title={match.have.purpose === 'rent' ? 'Landlord' : 'Seller'} side={match.have} onOpen={onOpen} />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-2">
        {ACTIONS.map((action) => {
          const on = action.keeps && status === action.status;
          return (
            <button
              key={action.status}
              type="button"
              className="btn-secondary"
              style={on ? { ...action.colours, fontWeight: 700 } : undefined}
              aria-pressed={action.keeps ? on : undefined}
              disabled={mark.isPending}
              onClick={() => choose(action)}
            >
              {on ? `✓ ${action.label}` : action.label}
            </button>
          );
        })}
      </div>
    </li>
  );
}

/** First, previous, the page you are on, next, last — and how many there are, so nobody scrolls to find out. */
function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }): JSX.Element | null {
  if (pages <= 1) return null;
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-label="Pages of the call sheet">
      <span className="text-muted">{from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}</span>
      <span className="flex items-center gap-1">
        <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPage(1)}>First</button>
        <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
        <span className="px-2 font-semibold">Page {page} of {pages}</span>
        <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
        <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => onPage(pages)}>Last</button>
      </span>
    </nav>
  );
}

export default function MarketIntroductions(): JSX.Element {
  const queryClient = useQueryClient();
  const [crossGroupOnly, setCrossGroupOnly] = useState(true);
  const [minScore, setMinScore] = useState(0.5);
  const [message, setMessage] = useState<MessageToShow | null>(null);
  const [category, setCategory] = useState('');
  const [sizeMin, setSizeMin] = useState('');
  const [sizeMax, setSizeMax] = useState('');
  const [area, setArea] = useState('');
  const [bhk, setBhk] = useState('');
  const [purpose, setPurpose] = useState<'' | 'sale' | 'rent'>('');
  const [sort, setSort] = useState<MarketIntroductionSort>('best');
  const [status, setStatus] = useState<'' | 'new' | 'called' | 'meeting' | 'won' | 'lost'>('');
  const [page, setPage] = useState(1);
  const settled = useSettled({ sizeMin, sizeMax, area });
  const narrowed = Boolean(category || sizeMin || sizeMax || area.trim() || bhk || purpose || status);
  const clearFilters = (): void => { setCategory(''); setSizeMin(''); setSizeMax(''); setArea(''); setBhk(''); setPurpose(''); setStatus(''); };
  const sureShot = minScore >= 0.8;
  const filters = {
    crossGroupOnly, minScore: sureShot ? 0.7 : minScore, sureShot, sort,
    category: category || undefined,
    sizeMinSqYd: settled.sizeMin ? Number(settled.sizeMin) : undefined,
    sizeMaxSqYd: settled.sizeMax ? Number(settled.sizeMax) : undefined,
    area: settled.area.trim() || undefined,
    bhk: bhk ? Number(bhk) : undefined,
    purpose: purpose || undefined,
    status: status || undefined,
  };
  // A different question starts at its first page.
  const filterKey = JSON.stringify(filters);
  useEffect(() => setPage(1), [filterKey]);
  const query = { ...filters, page, pageSize: PAGE_SIZE };
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
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['market', 'introductions', query],
    queryFn: () => api.marketIntroductions(query),
    // Page two replaces page one without a blank screen between them, and a click never refetches the list under the pointer.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const goTo = (next: number): void => { setPage(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        A buyer in one group who fits a seller in another, property by property — only deals posted in the last 45 days, on both sides. Ring both, fix a meeting,
        and mark what happened: the button takes a colour and stays until you press it again. "Not for us" and "Not a real match" put a pairing away for good, and the second one teaches the matcher.
      </p>
      <div className="card space-y-2 p-3" role="search" aria-label="Filter and sort the call sheet">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Type of property">
            <option value="">Any type</option>
            {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <input className="input w-24" inputMode="numeric" placeholder="Size from" value={sizeMin} onChange={(e) => setSizeMin(e.target.value.replace(/\D/g, ''))} aria-label="Smallest size in square yards" />
          <input className="input w-24" inputMode="numeric" placeholder="Size to" value={sizeMax} onChange={(e) => setSizeMax(e.target.value.replace(/\D/g, ''))} aria-label="Largest size in square yards" />
          <span className="text-xs text-muted">sq yd</span>
          <input className="input w-44" placeholder="Area, sector or project" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area" />
          <select className="input w-auto" value={bhk} onChange={(e) => setBhk(e.target.value)} aria-label="BHK">
            <option value="">Any BHK</option>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} BHK</option>)}
          </select>
          <select className="input w-auto" value={purpose} onChange={(e) => setPurpose(e.target.value as '' | 'sale' | 'rent')} aria-label="Sale or rent">
            <option value="">Sale and rent</option>
            <option value="sale">Sale</option>
            <option value="rent">Rent</option>
          </select>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Show pairings by status">
            <option value="">Every status</option>
            <option value="new">Not worked yet</option>
            <option value="called">Called</option>
            <option value="meeting">Meeting fixed</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
          {narrowed && <button type="button" className="btn-secondary" onClick={clearFilters}>Clear filters</button>}
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-2 text-sm">
          <span className="font-semibold" aria-live="polite" data-testid="match-count">
            {data ? `${total.toLocaleString('en-IN')} pairing${total === 1 ? '' : 's'}` : 'Counting…'}{isFetching && data ? ' · updating…' : ''}
          </span>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={crossGroupOnly} onChange={(e) => setCrossGroupOnly(e.target.checked)} /> Only people in different groups
          </label>
          <select className="input w-auto" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} aria-label="How good a fit">
            <option value={0.5}>Possible and strong</option>
            <option value={0.7}>Strong only</option>
            <option value={0.8}>Sure-shot (strong, and Jev agrees)</option>
          </select>
          <button type="button" className="btn-secondary" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <label className="ml-auto inline-flex items-center gap-1.5">
            Sort
            <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as MarketIntroductionSort)} aria-label="Sort the call sheet">
              {SORTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>
      </div>
      {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
      {error && <p className="text-sm text-negative">Could not load the introductions: {(error as Error).message}</p>}
      {data && (data.matches.length === 0 ? (
        <EmptyState
          title={narrowed ? 'Nothing matches those filters' : 'Nothing to ring about yet'}
          body={narrowed ? 'Loosen a filter, or clear them to see everything from the last 45 days.' : 'Introductions appear once groups with both buyers and sellers are added. A property needs a sector or a named area to be matched.'}
        />
      ) : (
        <>
          <Pager page={page} pages={pages} total={total} onPage={goTo} />
          <ul className="space-y-3">
            {data.matches.map((match) => <Introduction key={match.id} match={match} onOpen={setMessage} />)}
          </ul>
          <Pager page={page} pages={pages} total={total} onPage={goTo} />
        </>
      ))}
      <DealMessageDialog message={message} onClose={() => setMessage(null)} />
    </div>
  );
}
