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
import { formatIndianPrice, relativeTime } from '@ipropy/shared';
import { Phone, Upload, Users } from 'lucide-react';
import { PeekLink } from '../components/PeekLink';
import { api, type MarketPost } from '../lib/api';
import { Badge, EmptyState, Spinner } from '../components/ui';
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

function DealCard({ post, focused }: { post: MarketPost; focused: boolean }): JSX.Element {
  const price = priceText(post);
  const [showMatches, setShowMatches] = useState(focused);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'center' }); }, [focused]);
  return (
    <li ref={ref} className={`card space-y-2 p-4 ${focused ? 'ring-2 ring-brand-400' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge color={post.kind === 'have' ? '#16a34a' : post.kind === 'want' ? '#2563eb' : '#64748b'}>{KIND_LABEL[post.kind]}</Badge>
        {post.bhk && <Badge>{post.bhk} BHK</Badge>}
        {price && <Badge>{price}</Badge>}
        {post.localities.map((name) => <Badge key={name}>{name}</Badge>)}
        <span className="ml-auto text-muted">{post.lastPostedAt ? relativeTime(post.lastPostedAt) : ''}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{post.body}</p>
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

function ImportBox(): JSX.Element {
  const queryClient = useQueryClient();
  const [group, setGroup] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (): Promise<void> => {
    if (!group.trim() || !file) return;
    setBusy(true);
    try {
      const result = await api.importMarketGroup(group.trim(), file);
      toast.success(
        `${result.newDeals} new deal${result.newDeals === 1 ? '' : 's'} from ${group.trim()}`,
        `${result.messages} messages read · ${result.deals} looked like deals · ${result.repeats} already held`,
      );
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ['market'] });
    } catch (err) {
      toast.error('Could not read that export', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Add a group</h2>
        <p className="text-xs text-muted">
          In WhatsApp, open the group → ⋮ → More → Export chat → Without media, and choose the .txt file here.
          Uploading the same group again only adds what is new.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="Group name, e.g. Greenfields Dealers" value={group} onChange={(e) => setGroup(e.target.value)} />
        <input type="file" accept=".txt,text/plain" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Exported chat file" />
        <button type="button" className="btn-primary" disabled={busy || !group.trim() || !file} onClick={() => void send()}>
          {busy ? <Spinner /> : <Upload className="h-4 w-4" />} Read the deals
        </button>
      </div>
    </div>
  );
}

export default function MarketFeedPage(): JSX.Element {
  // An alert links here with ?deal=<id>; that card opens with its matches showing.
  const [params] = useSearchParams();
  const focusedDeal = params.get('deal');
  const [kind, setKind] = useState('');
  const [bhk, setBhk] = useState('');
  const [maxCr, setMaxCr] = useState('');
  const [locality, setLocality] = useState('');
  const [text, setText] = useState('');

  const query = {
    kind: kind || undefined,
    bhk: bhk || undefined,
    maxLakh: maxCr ? Number(maxCr) * 100 : undefined,
    locality: locality.trim() || undefined,
    text: text.trim() || undefined,
    days: 90,
    limit: 100,
  };
  const { data, isLoading, error } = useQuery({
    queryKey: ['market', query],
    queryFn: () => api.marketPosts(query),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold">Dealer groups</h1>
        <p className="text-sm text-muted">Deals posted in WhatsApp groups in the last 90 days. Ask about them in plain words at /ask too.</p>
      </div>

      <ImportBox />

      <div className="flex flex-wrap gap-2">
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Has or wants">
          <option value="">Has or wants</option>
          <option value="have">Has a property</option>
          <option value="want">Wants a property</option>
        </select>
        <select className="input w-auto" value={bhk} onChange={(e) => setBhk(e.target.value)} aria-label="BHK">
          <option value="">Any BHK</option>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} BHK</option>)}
        </select>
        <input className="input w-36" inputMode="decimal" placeholder="Up to ₹ Cr" value={maxCr} onChange={(e) => setMaxCr(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Up to crore" />
        <input className="input w-44" placeholder="Locality" value={locality} onChange={(e) => setLocality(e.target.value)} />
        <input className="input min-w-[10rem] flex-1" placeholder="Any word in the post" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
      {error && <p className="text-sm text-negative">Could not load the deals: {(error as Error).message}</p>}
      {data && (
        <>
          <p className="text-xs text-muted">{data.total} deal{data.total === 1 ? '' : 's'}{data.total > data.posts.length ? `, newest ${data.posts.length} shown` : ''}</p>
          {data.posts.length === 0 ? (
            <EmptyState title="No deals yet" body="Add a group's export above, or loosen the filters." />
          ) : (
            <ul className="space-y-3">{data.posts.map((post) => <DealCard key={post.id} post={post} focused={post.id === focusedDeal} />)}</ul>
          )}
        </>
      )}
    </div>
  );
}
