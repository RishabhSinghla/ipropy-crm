/**
 * Dealer groups — every deal other dealers posted, in one searchable list.
 *
 * 11 October 2026, the owner: buyers and sellers turn up in dealer WhatsApp
 * groups all day and nobody can keep them in their head. A group's export goes
 * in at the top; below it is every deal, newest first, filtered the way a rep
 * thinks — have or want, BHK, budget, locality. The same list is what
 * chat.ipropy.com searches when somebody asks "who has a 3 BHK under 1.5 Cr".
 */
import { type JSX, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MARKET_FEED_DAYS, formatIndianPrice, relativeTime } from '@ipropy/shared';
import { Phone, Upload, Users } from 'lucide-react';
import { PeekLink } from '../components/PeekLink';
import { api, type MarketImportRow, type MarketPost } from '../lib/api';
import DealMessageDialog, { type MessageToShow } from '../components/DealMessageDialog';
import { Badge, EmptyState, Spinner } from '../components/ui';
import SearchableSelect from '../components/SearchableSelect';
import MarketDealers from '../components/MarketDealers';
import MarketIntroductions from '../components/MarketIntroductions';
import { toast } from '../lib/store';

function priceText(post: MarketPost): string | null {
  if (post.priceMinLakh === null) return null;
  const low = formatIndianPrice(post.priceMinLakh * 100_000);
  if (post.priceMaxLakh === null || post.priceMaxLakh === post.priceMinLakh) return low;
  return `${low} – ${formatIndianPrice(post.priceMaxLakh * 100_000)}`;
}

const KIND_LABEL: Record<MarketPost['kind'], string> = { have: 'Has a property', want: 'Wants a property', unknown: 'Not sure' };

/** Our own records this deal fits, asked for only when somebody wants to know. */
function DealMatches({ postId }: { postId: string }): JSX.Element {
  const { data, isLoading, error } = useQuery({ queryKey: ['market', 'matches', postId], queryFn: () => api.marketMatches(postId) });
  if (isLoading) return <Spinner />;
  if (error) return <p className="text-xs text-negative">{(error as Error).message}</p>;
  if (!data?.length) {
    return <p className="text-xs text-muted">None of the records you can open fit this. Matching needs a locality from your list, plus a BHK or a price.</p>;
  }
  return (
    <ul className="space-y-1">
      {data.map((match) => (
        <li key={match.recordId}>
          <PeekLink module={match.module} id={match.recordId} label={match.label} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
            {match.label}
          </PeekLink>
          <span className="ml-2 text-xs text-muted">{match.module === 'leads' ? 'Contact' : 'Inventory'}</span>
        </li>
      ))}
    </ul>
  );
}

function DealCard({ post, focused, onOpen }: { post: MarketPost; focused: boolean; onOpen: (message: MessageToShow) => void }): JSX.Element {
  const price = priceText(post);
  const [showMatches, setShowMatches] = useState(focused);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'center' }); }, [focused]);
  return (
    <li ref={ref} className={`card space-y-2 p-4 ${focused ? 'ring-2 ring-brand-400' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge color={post.kind === 'have' ? '#16a34a' : post.kind === 'want' ? '#2563eb' : '#64748b'}>{KIND_LABEL[post.kind]}</Badge>
        {post.bhk && <Badge>{post.bhk} BHK</Badge>}
        {post.category && <Badge>{post.category}</Badge>}
        {price && <Badge>{price}</Badge>}
        {post.localities.map((name) => <Badge key={name}>{name}</Badge>)}
        <span className="ml-auto text-muted">{post.lastPostedAt ? relativeTime(post.lastPostedAt) : ''}</span>
      </div>
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => onOpen({ postId: post.id, body: post.body, posterName: post.posterName, posterPhone: post.posterPhone, groups: post.groups, postedAt: post.lastPostedAt })}
        aria-label="Read the full message"
      >
        <span className="line-clamp-6 whitespace-pre-wrap text-sm">{post.body}</span>
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="font-medium text-[var(--text)]">{post.posterName ?? 'Unknown sender'}</span>
        <span>
          {post.groups.join(', ')}
          {post.seenCount > 1 ? ` · posted ${post.seenCount} times` : ''}
        </span>
        {post.posterPhone && (
          <a href={`tel:${post.posterPhone}`} className="ml-auto inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300">
            <Phone className="h-3.5 w-3.5" /> {post.posterPhone}
          </a>
        )}
      </div>
      {post.kind !== 'unknown' && (
        <div className="border-t border-[var(--border)] pt-2">
          <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300" onClick={() => setShowMatches((open) => !open)}>
            <Users className="h-3.5 w-3.5" /> {post.kind === 'have' ? 'Which of our contacts want this?' : 'Which of our units fit this buyer?'}
          </button>
          {showMatches && <div className="mt-2"><DealMatches postId={post.id} /></div>}
        </div>
      )}
    </li>
  );
}

const STATUS_TEXT: Record<MarketImportRow['status'], string> = {
  queued: 'Waiting', running: 'Reading…', done: 'Done', failed: 'Failed', duplicate: 'Already read',
};

function importSummary(row: MarketImportRow): string {
  if (row.status === 'failed' || row.status === 'duplicate') return row.error ?? '';
  if (row.status !== 'done') return 'Names, sectors and prices are being read — you can leave this page.';
  // A message can be many properties: say both, or "2 messages" hides what was found.
  const parts = [`${row.newDeals} new message${row.newDeals === 1 ? '' : 's'}`, `${row.listings} propert${row.listings === 1 ? 'y' : 'ies'} found`];
  if (row.repeats) parts.push(`${row.repeats} already known`);
  if (row.skippedOld) parts.push(`${row.skippedOld} skipped: older than ${MARKET_FEED_DAYS} days or read before`);
  return `${parts.join(' · ')} · ${row.messages} lines in the file`;
}

/**
 * Drop any number of group exports. Each is named from its file, read in the
 * background and only from where that group was last read to, so a second drop of a
 * group costs only what is new. The list below is what became of everything dropped.
 */
function ImportBox(): JSX.Element {
  const queryClient = useQueryClient();
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const imports = useQuery({
    queryKey: ['market', 'imports'],
    queryFn: api.marketImports,
    // Watch while anything is still being read, rest when nothing is.
    refetchInterval: (query) => (query.state.data?.imports.some((row) => row.status === 'queued' || row.status === 'running') ? 2000 : false),
  });
  const running = imports.data?.imports.filter((row) => row.status === 'queued' || row.status === 'running').length ?? 0;
  const wasRunning = useRef(0);
  useEffect(() => {
    // A group finishing is news for every list on this page.
    if (wasRunning.current > 0 && running < wasRunning.current) void queryClient.invalidateQueries({ queryKey: ['market'] });
    wasRunning.current = running;
  }, [running, queryClient]);

  const send = async (files: File[]): Promise<void> => {
    const wanted = files.filter((file) => /\.(txt|zip)$/i.test(file.name) || file.type === 'text/plain' || file.type.includes('zip'));
    if (!wanted.length) { toast.error('Those are not WhatsApp exports', 'Drop the .txt or .zip file WhatsApp made.'); return; }
    setBusy(true);
    try {
      const result = await api.importMarketFiles(wanted, wanted.length === 1 ? group.trim() || undefined : undefined);
      const queued = result.imports.filter((row) => row.status === 'queued').length;
      toast.success(`${queued} group${queued === 1 ? '' : 's'} queued`, result.imports.length > queued ? 'The rest were already read or could not be.' : 'You can leave this page; they are read in the background.');
      setGroup('');
      await imports.refetch();
    } catch (err) {
      toast.error('Could not take those files', (err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="card space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Add groups</h2>
        <p className="text-xs text-muted">
          In WhatsApp, open a group → ⋮ → More → Export chat → Without media. Drop the .txt or .zip files here, as many at once as you like.
          Each group is named from its file. Dropping a group again reads only what is new.
        </p>
      </div>
      <div
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors ${over ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-[var(--border)]'}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void send([...e.dataTransfer.files]); }}
        data-testid="market-dropzone"
      >
        {busy ? <Spinner /> : <Upload className="h-5 w-5 text-muted" />}
        <p>Drop group exports here, or</p>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => input.current?.click()}>Choose files</button>
        <input
          ref={input}
          type="file"
          multiple
          accept=".txt,.zip,text/plain,application/zip"
          className="sr-only"
          aria-label="Exported chat files"
          onChange={(e) => void send([...(e.target.files ?? [])])}
        />
        <label className="flex items-center gap-2 text-xs text-muted">
          Group name, only if you drop one file and want to rename it
          <input className="input w-56" placeholder="Taken from the file's name" value={group} onChange={(e) => setGroup(e.target.value)} />
        </label>
      </div>
      {imports.data && imports.data.imports.length > 0 && (() => {
        // Only the latest drop: everything since the newest group was queued, because the older log is not today's question.
        const all = imports.data.imports;
        const newest = Date.parse(all[0]!.createdAt);
        const drop = all.filter((row) => newest - Date.parse(row.createdAt) < 60 * 60_000);
        const done = drop.filter((row) => row.status === 'done' || row.status === 'duplicate' || row.status === 'failed').length;
        const failed = drop.filter((row) => row.status === 'failed').length;
        const newDeals = drop.reduce((sum, row) => sum + row.newDeals, 0);
        return (
          <div className="space-y-2" data-testid="market-imports">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold">{done === drop.length ? `All ${drop.length} groups read` : `Reading ${done} of ${drop.length} groups…`}</span>
              <span className="text-muted">{newDeals.toLocaleString('en-IN')} new deals{failed ? ` · ${failed} could not be read` : ''}</span>
              <span className="ml-auto text-muted">{relativeTime(all[0]!.createdAt)}</span>
            </div>
            {done < drop.length && (
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]" role="progressbar" aria-valuenow={done} aria-valuemax={drop.length}>
                <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${Math.round((done / drop.length) * 100)}%` }} />
              </div>
            )}
            <ul className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)]">
              {drop.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                  <span className="min-w-[10rem] font-semibold">{row.groupName}</span>
                  <Badge color={row.status === 'done' ? '#16a34a' : row.status === 'failed' ? '#dc2626' : row.status === 'duplicate' ? '#64748b' : '#d97706'}>{STATUS_TEXT[row.status]}</Badge>
                  <span className="text-muted">{importSummary(row)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}
    </div>
  );
}

function DealsTab(): JSX.Element {
  // Alerts link here: ?deal=<id> opens that card with its matches showing, and
  // ?kind=&locality= (a new buyer's alert) opens the list already narrowed.
  const [params] = useSearchParams();
  const focusedDeal = params.get('deal');
  const [kind, setKind] = useState(params.get('kind') ?? '');
  const [bhk, setBhk] = useState('');
  const [maxCr, setMaxCr] = useState('');
  const [locality, setLocality] = useState(params.get('locality') ?? '');
  const [text, setText] = useState('');
  const [message, setMessage] = useState<MessageToShow | null>(null);

  const query = {
    kind: kind || undefined,
    bhk: bhk || undefined,
    maxLakh: maxCr ? Number(maxCr) * 100 : undefined,
    locality: locality.trim() || undefined,
    text: text.trim() || undefined,
    days: MARKET_FEED_DAYS,
    limit: 100,
  };
  const { data, isLoading, error } = useQuery({
    queryKey: ['market', query],
    queryFn: () => api.marketPosts(query),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Deals posted in WhatsApp groups in the last {MARKET_FEED_DAYS} days. Ask about them in plain words at /ask too.</p>

      <div className="flex flex-wrap gap-2">
        <SearchableSelect ariaLabel="Has or wants" value={kind} onChange={setKind}
          options={[{ value: '', label: 'Has or wants' }, { value: 'have', label: 'Has a property', keywords: 'seller sale offer' }, { value: 'want', label: 'Wants a property', keywords: 'buyer requirement' }]} />
        <SearchableSelect ariaLabel="BHK" value={bhk} onChange={setBhk}
          options={[{ value: '', label: 'Any BHK' }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} BHK` }))]} />
        <input className="input w-36" inputMode="decimal" placeholder="Up to ₹ Cr" value={maxCr} onChange={(e) => setMaxCr(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Up to crore" />
        <input className="input w-44" placeholder="Locality" value={locality} onChange={(e) => setLocality(e.target.value)} />
        <input className="input min-w-[10rem] flex-1" placeholder="Any word in the post" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      <DealMessageDialog message={message} onClose={() => setMessage(null)} />
      {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
      {error && <p className="text-sm text-negative">Could not load the deals: {(error as Error).message}</p>}
      {data && (
        <>
          <p className="text-xs text-muted">{data.total} deal{data.total === 1 ? '' : 's'}{data.total > data.posts.length ? `, newest ${data.posts.length} shown` : ''}</p>
          {data.posts.length === 0 ? (
            <EmptyState title="No deals yet" body="Add a group's export above, or loosen the filters." />
          ) : (
            <ul className="space-y-3">{data.posts.map((post) => <DealCard key={post.id} post={post} focused={post.id === focusedDeal} onOpen={setMessage} />)}</ul>
          )}
        </>
      )}
    </div>
  );
}

/** Every group the feed reads, in one list: what it holds today, when its newest message was posted, when it was last read. */
function GroupsTab(): JSX.Element {
  const { data, isLoading, error } = useQuery({ queryKey: ['market', 'groups'], queryFn: api.marketGroups, staleTime: 30_000 });
  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>;
  if (error) return <p className="text-sm text-negative">Could not load the groups: {(error as Error).message}</p>;
  const groups = data?.groups ?? [];
  if (!groups.length) return <EmptyState title="No groups yet" body="Drop a group's export above." />;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">{groups.length} groups. The feed keeps the last {MARKET_FEED_DAYS} days of each and nothing older.</p>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr><th className="px-3 py-2 font-semibold">Group</th><th className="px-3 py-2 text-right font-semibold">Deals held</th><th className="px-3 py-2 font-semibold">Newest message</th><th className="px-3 py-2 font-semibold">Last read</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {groups.map((group) => (
              <tr key={group.name}>
                <td className="px-3 py-2 font-semibold">{group.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{group.deals.toLocaleString('en-IN')}</td>
                <td className="px-3 py-2 text-muted">{group.newestAt ? relativeTime(group.newestAt) : '—'}</td>
                <td className="px-3 py-2 text-muted">{group.lastReadAt ? relativeTime(group.lastReadAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Tab = 'calls' | 'deals' | 'dealers' | 'groups';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'calls', label: 'Calls today' },
  { id: 'deals', label: 'All deals' },
  { id: 'dealers', label: 'Dealers' },
  { id: 'groups', label: 'Groups' },
];

export default function MarketFeedPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  // An alert about one deal or one buyer opens the list it is about; otherwise the call sheet leads.
  const wanted = params.get('tab');
  const tab: Tab = wanted === 'calls' || wanted === 'deals' || wanted === 'dealers' || wanted === 'groups'
    ? wanted
    : params.get('deal') || params.get('kind') || params.get('locality') ? 'deals' : 'calls';

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold">Dealer groups</h1>
        <p className="text-sm text-muted">What other dealers post in their WhatsApp groups, read by Jev and matched for you.</p>
      </div>

      <ImportBox />

      <div role="tablist" className="flex gap-1 border-b border-[var(--border)]">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === item.id ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-muted hover:text-[var(--text)]'}`}
            onClick={() => setParams({ tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'calls' && <MarketIntroductions />}
      {tab === 'deals' && <DealsTab />}
      {tab === 'dealers' && <MarketDealers />}
      {tab === 'groups' && <GroupsTab />}
    </div>
  );
}
