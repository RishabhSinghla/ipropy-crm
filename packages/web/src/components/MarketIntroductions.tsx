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
import { MARKET_FEED_DAYS, formatIndianPrice } from '@ipropy/shared';
import { ChevronLeft, ChevronRight, Phone } from 'lucide-react';
import { api, type MarketDealSide, type MarketIntroduction, type MarketIntroductionSort, type MarketIntroductionStatus } from '../lib/api';
import DealMessageDialog, { type MessageToShow } from './DealMessageDialog';
import JevStatusStrip, { useJevStatus } from './JevStatusStrip';
import SearchableSelect from './SearchableSelect';
import { Badge, EmptyState, Spinner } from './ui';
import { toast } from '../lib/store';

/**
 * The seven answers. The first five are work in progress: the pairing stays where it is, the button fills with a colour (white text on each clears AA),
 * and pressing it again takes the answer back. The last two put the pairing away for good — "not a real match" also
 * teaches the matcher and Jev — so they ask for no colour and leave a line with one way back, for this visit only.
 */
const ACTIONS: Array<{ status: MarketIntroductionStatus; label: string; keeps: boolean; colours?: { background: string; color: string; borderColor: string } }> = [
  { status: 'called', label: 'Called', keeps: true, colours: { background: '#4e45d5', color: '#ffffff', borderColor: '#4e45d5' } },
  { status: 'busy', label: 'Busy', keeps: true, colours: { background: '#0f766e', color: '#ffffff', borderColor: '#0f766e' } },
  { status: 'meeting', label: 'Meeting fixed', keeps: true, colours: { background: '#b45309', color: '#ffffff', borderColor: '#b45309' } },
  { status: 'won', label: 'Won', keeps: true, colours: { background: '#15803d', color: '#ffffff', borderColor: '#15803d' } },
  { status: 'lost', label: 'Lost', keeps: true, colours: { background: '#b91c1c', color: '#ffffff', borderColor: '#b91c1c' } },
  { status: 'dismissed', label: 'Not for us', keeps: false },
  { status: 'bad_match', label: 'Not a real match', keeps: false },
];

const PAGE_SIZE = 25;

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

function placeText(key: string): string {
  if (key.includes(':')) return key.replace(/^(.*?):block (.)$/, (_m, project: string, block: string) => `${project.toUpperCase()} · Block ${block}`);
  const sector = /^sector (\d+)([a-z]?)$/.exec(key);
  return sector ? `Sector ${sector[1]}${sector[2]!.toUpperCase()}` : key.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** How fresh a posting is, as a coloured chip: green is today or yesterday, amber is getting old. */
function Freshness({ postedAt }: { postedAt: string | null }): JSX.Element | null {
  if (!postedAt) return null;
  const days = Math.floor((Date.now() - new Date(postedAt).getTime()) / 86_400_000);
  const text = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
  const tone = days <= 1 ? 'bg-[var(--positive-soft)] text-[var(--positive-on-soft)]' : days <= 14 ? 'bg-[var(--surface-muted)] text-[var(--text)]' : 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{text}</span>;
}

/** The few facts a dealer reads first, large: size, type, BHK and the money — what the buyer can spend or the seller wants. */
function keyFacts(side: MarketDealSide): string[] {
  const out: string[] = [];
  if (side.sizeSqYd) out.push(`${side.sizeSqYd} yd`);
  if (side.category) out.push(side.category);
  if (side.bhk) out.push(`${side.bhk} BHK`);
  const money = side.kind === 'want' ? side.priceMaxLakh : side.priceMinLakh;
  if (money !== null) out.push(`${side.kind === 'want' ? 'Budget up to ' : ''}${formatIndianPrice(money * 100_000)}${side.purpose === 'rent' ? ' / month' : ''}`);
  return out;
}

const ROLE_TONE = { buy: '#15803d', sell: '#0369a1' } as const;

function Side({ title, side, onOpen }: { title: string; side: MarketDealSide; onOpen: (message: MessageToShow) => void }): JSX.Element {
  const open = (): void => onOpen({
    postId: side.postId, body: side.body, posterName: side.posterName, posterPhone: side.posterPhone,
    groups: side.groups, postedAt: side.postedAt, highlight: side.summary,
  });
  const tone = side.kind === 'want' ? ROLE_TONE.buy : ROLE_TONE.sell;
  const facts = keyFacts(side);
  const named = side.posterName && !/^[+\d\s]+$/.test(side.posterName);
  return (
    <div className="min-w-0 flex-1 space-y-2 rounded-lg border border-[var(--border)] p-3" style={{ borderLeft: `4px solid ${tone}` }}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide" style={{ color: tone }}>{title}</p>
        <Freshness postedAt={side.postedAt} />
      </div>
      {named && <p className="truncate text-base font-bold leading-tight">{side.posterName}</p>}
      {side.posterPhone && (
        <a href={`tel:${side.posterPhone}`} className="inline-flex items-center gap-1.5 text-lg font-bold tabular-nums text-brand-700 hover:underline dark:text-brand-300">
          <Phone className="h-4 w-4" /> {side.posterPhone}
        </a>
      )}
      {facts.length > 0 && <p className="flex flex-wrap gap-1.5">{facts.map((fact) => <span key={fact} className="rounded-md bg-[var(--surface-muted)] px-2 py-1 text-sm font-semibold">{fact}</span>)}</p>}
      {side.placeKeys.length > 0 && <p className="flex flex-wrap gap-1">{side.placeKeys.slice(0, 3).map((key) => <Badge key={key}>{placeText(key)}</Badge>)}</p>}
      <button type="button" onClick={open} className="block w-full text-left" aria-label={`Read the full message from ${side.posterName ?? 'this dealer'}`}>
        <span className="line-clamp-2 whitespace-pre-wrap text-xs text-muted">{side.summary || side.body}</span>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted">{side.groups.slice(0, 2).join(' · ')}{side.groups.length > 2 ? ` +${side.groups.length - 2}` : ''}</span>
        <button type="button" onClick={open} className="shrink-0 font-semibold text-brand-700 hover:underline dark:text-brand-300">Read full message</button>
      </div>
    </div>
  );
}

/** Why the two fit, as ticks a person reads in a second — not the sentence the rules wrote. */
export function whyItFits(match: MarketIntroduction): string[] {
  const out: string[] = [];
  const area = match.reasons.map((reason) => /^same (?:area|sector): ([^/]+)/.exec(reason)?.[1]?.trim()).find(Boolean);
  if (area) out.push(area);
  if (match.have.category) out.push(match.have.category);
  if (match.want.sizeSqYd && match.have.sizeSqYd) out.push(`${match.want.sizeSqYd} ≈ ${match.have.sizeSqYd} yd`);
  if (match.have.bhk && match.want.bhk) out.push(`${match.have.bhk} BHK`);
  if (match.reasons.includes('within budget')) out.push('within budget');
  return out;
}

function Introduction({ match, onOpen }: { match: MarketIntroduction; onOpen: (message: MessageToShow) => void }): JSX.Element {
  // What is shown is the answer the server last accepted, so a click changes the screen at once and a refused one changes it back.
  const [status, setStatus] = useState<MarketIntroductionStatus>(match.status);
  useEffect(() => setStatus(match.status), [match.status]);
  // Every hook sits above the early return below. "Not for us" and "Not a real match" swap this card for a one-line
  // note, and a hook placed after that return is skipped on that render: React error #300, a dead screen.
  const jevStatus = useJevStatus().data;
  const mark = useMutation({
    mutationFn: (next: MarketIntroductionStatus) => api.setMarketIntroduction(match.want.id, match.have.id, next),
    onMutate: (next) => { const before = status; setStatus(next); return { before }; },
    onSuccess: (_saved, next) => {
      const action = ACTIONS.find((item) => item.status === next);
      toast.success(action ? `Marked “${action.label}”` : 'Answer cleared');
    },
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
  // Three different things used to read "checking" or "not checked": rated (a score), waiting its turn, and could not be read.
  const verdict = jev === null
    ? ((match.jevTried ?? 0) >= 3 ? { text: 'Jev could not read this', tone: 'bg-[var(--surface-muted)] text-muted' }
      : jevStatus && !jevStatus.connection.connected ? { text: 'Jev not connected', tone: 'bg-[var(--surface-muted)] text-muted' }
        : { text: 'Waiting for Jev', tone: 'bg-[var(--surface-muted)] text-muted' })
    : sure ? { text: `Sure-shot · ${Math.round(jev * 100)}%`, tone: 'bg-[var(--positive-soft)] text-[var(--positive-on-soft)]' }
      : { text: `Possible · ${Math.round(jev * 100)}%`, tone: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100' };
  const ticks = whyItFits(match);
  return (
    <li className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-sm font-bold ${verdict.tone}`} title="Jev's read of whether the offer answers the requirement">{verdict.text}</span>
        {ticks.map((tick) => <span key={tick} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-semibold">✓ {tick}</span>)}
        {match.crossGroup && <span className="ml-auto text-xs text-muted">Different groups</span>}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <Side title={match.want.purpose === 'rent' ? 'Tenant wants' : 'Buyer wants'} side={match.want} onOpen={onOpen} />
        <div className="hidden items-center text-2xl text-muted sm:flex" aria-hidden="true">⇄</div>
        <Side title={match.have.purpose === 'rent' ? 'Landlord offers' : 'Seller offers'} side={match.have} onOpen={onOpen} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <span className="mr-1 text-xs font-semibold text-muted">Your answer</span>
        {ACTIONS.filter((action) => action.keeps).map((action) => {
          const on = status === action.status;
          return (
            <button
              key={action.status}
              type="button"
              className="btn-secondary"
              style={on ? { ...action.colours, fontWeight: 700 } : undefined}
              aria-pressed={on}
              disabled={mark.isPending}
              onClick={() => choose(action)}
            >
              {on ? `✓ ${action.label}` : action.label}
            </button>
          );
        })}
        {status === 'busy' && <span className="text-xs text-muted">Line was busy — ring again in a couple of hours.</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          {ACTIONS.filter((action) => !action.keeps).map((action) => (
            <button key={action.status} type="button" className="btn-ghost text-xs text-muted" disabled={mark.isPending} onClick={() => choose(action)}>
              {action.label}
            </button>
          ))}
        </span>
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
  const [status, setStatus] = useState<'' | 'new' | 'called' | 'busy' | 'meeting' | 'won' | 'lost'>('');
  const [day, setDay] = useState<'' | 'today' | 'yesterday'>('');
  const [sides, setSides] = useState<string[]>(['buyer', 'seller', 'tenant', 'landlord']);
  const [page, setPage] = useState(1);
  const settled = useSettled({ sizeMin, sizeMax, area });
  const narrowed = Boolean(category || sizeMin || sizeMax || area.trim() || bhk || purpose || status || day);
  const clearFilters = (): void => { setCategory(''); setSizeMin(''); setSizeMax(''); setArea(''); setBhk(''); setPurpose(''); setStatus(''); setDay(''); };
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
    day: day || undefined,
    sides: day ? sides : undefined,
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
        A buyer in one group who fits a seller in another, property by property — only deals posted in the last {MARKET_FEED_DAYS} days, on both sides. Ring both, fix a meeting,
        and mark what happened: the button takes a colour and stays until you press it again. "Not for us" and "Not a real match" put a pairing away for good, and the second one teaches the matcher.
      </p>
      <div className="card space-y-2 p-3" role="search" aria-label="Filter and sort the call sheet">
        <div className="flex flex-wrap items-center gap-2" data-testid="day-filter">
          {(['today', 'yesterday'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={day === value}
              className="btn-secondary"
              style={day === value ? { background: '#4e45d5', color: '#fff', borderColor: '#4e45d5', fontWeight: 700 } : undefined}
              onClick={() => setDay(day === value ? '' : value)}
            >
              {value === 'today' ? 'Today' : 'Yesterday'}
            </button>
          ))}
          {day && (
            <>
              <span className="text-xs text-muted">who posted {day === 'today' ? 'today' : 'yesterday'}:</span>
              {([['buyer', 'Buyers'], ['seller', 'Sellers'], ['tenant', 'Tenants'], ['landlord', 'Landlords']] as const).map(([value, label]) => (
                <label key={value} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={sides.includes(value)}
                    onChange={(e) => setSides((current) => (e.target.checked ? [...current, value] : current.filter((side) => side !== value)))}
                  />
                  {label}
                </label>
              ))}
              <span className="text-xs text-muted">The other side can be from any of the last {MARKET_FEED_DAYS} days.</span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchableSelect ariaLabel="Type of property" value={category} onChange={setCategory}
            options={[{ value: '', label: 'Any type' }, ...TYPES.map((type) => ({ value: type, label: type }))]} />
          <input className="input w-24" inputMode="numeric" placeholder="Size from" value={sizeMin} onChange={(e) => setSizeMin(e.target.value.replace(/\D/g, ''))} aria-label="Smallest size in square yards" />
          <input className="input w-24" inputMode="numeric" placeholder="Size to" value={sizeMax} onChange={(e) => setSizeMax(e.target.value.replace(/\D/g, ''))} aria-label="Largest size in square yards" />
          <span className="text-xs text-muted">sq yd</span>
          <input className="input w-44" placeholder="Area, sector or project" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area" />
          <SearchableSelect ariaLabel="BHK" value={bhk} onChange={setBhk}
            options={[{ value: '', label: 'Any BHK' }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} BHK` }))]} />
          <SearchableSelect ariaLabel="Sale or rent" value={purpose} onChange={(next) => setPurpose(next as '' | 'sale' | 'rent')}
            options={[{ value: '', label: 'Sale and rent' }, { value: 'sale', label: 'Sale', keywords: 'buy seller' }, { value: 'rent', label: 'Rent', keywords: 'tenant landlord lease' }]} />
          <SearchableSelect ariaLabel="Show pairings by status" value={status} onChange={(next) => setStatus(next as typeof status)}
            options={[
              { value: '', label: 'Every status' }, { value: 'new', label: 'Not worked yet' }, { value: 'called', label: 'Called' }, { value: 'busy', label: 'Busy', keywords: 'retry later engaged' },
              { value: 'meeting', label: 'Meeting fixed' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' },
            ]} />
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
        <JevStatusStrip />
      </div>
      {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
      {error && <p className="text-sm text-negative">Could not load the introductions: {(error as Error).message}</p>}
      {data && (data.matches.length === 0 ? (
        <EmptyState
          title={narrowed ? 'Nothing matches those filters' : 'Nothing to ring about yet'}
          body={narrowed ? 'Loosen a filter, or clear them to see everything from the last ' + MARKET_FEED_DAYS + ' days.' : 'Introductions appear once groups with both buyers and sellers are added. A property needs a sector or a named area to be matched.'}
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
