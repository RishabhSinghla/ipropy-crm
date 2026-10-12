/**
 * One of an Associate's four deal lists: what this dealer has posted in the
 * WhatsApp groups, as a table rather than as text in a comment.
 *
 * All four tabs read one answer (`['market', 'record-deals', id]`), so opening
 * a second tab asks nothing again and the number on the tab and the rows under
 * it cannot disagree. The deals are the Dealer groups page's own rows — stored
 * once — so a row links back there, where "which of our contacts want this?"
 * is one click away.
 */
import { type JSX, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatIndianPrice, relativeTime } from '@ipropy/shared';
import { ArrowUpDown, Search, SlidersHorizontal } from 'lucide-react';
import { api, type DealerDeal, type DealerDeals } from '../lib/api';
import DealMessageDialog, { type MessageToShow } from './DealMessageDialog';
import { Badge, EmptyState, Spinner } from './ui';
import { cn } from '../lib/utils';
import type { DealTabKey } from '../lib/splitViewLayout';

export const dealsQueryKey = (recordId: string) => ['market', 'record-deals', recordId] as const;

export const LIST_OF: Record<DealTabKey, keyof Omit<DealerDeals, 'truncated'>> = {
  deals_sale: 'forSale',
  deals_buyer: 'buyerRequirements',
  deals_rent: 'forRent',
  deals_tenant: 'tenantRequirements',
};

const COPY: Record<DealTabKey, { empty: string; price: string }> = {
  deals_sale: { empty: 'This dealer has not posted anything for sale in the groups you have added.', price: 'Asking' },
  deals_buyer: { empty: 'No buyer requirements from this dealer yet.', price: 'Budget' },
  deals_rent: { empty: 'Nothing to let from this dealer yet.', price: 'Rent' },
  deals_tenant: { empty: 'No tenant requirements from this dealer yet.', price: 'Budget' },
};

/** The Associates-only table columns, also exposed in Admin → Layouts. */
export const ASSOCIATE_DEAL_COLUMNS = [
  { key: 'property', label: 'Property / Requirement' },
  { key: 'location', label: 'Locality' },
  { key: 'price', label: 'Demand / Budget' },
  { key: 'size', label: 'Size (Sq. Yd.)' },
  { key: 'bedrooms', label: 'Bedrooms' },
  { key: 'category', label: 'Category' },
  { key: 'facing', label: 'Facing' },
  { key: 'floor', label: 'Floor / Portion' },
  { key: 'posted', label: 'WA Post Date' },
] as const;

export type AssociateDealColumn = typeof ASSOCIATE_DEAL_COLUMNS[number]['key'];
export const DEFAULT_ASSOCIATE_DEAL_COLUMNS: AssociateDealColumn[] = ['property', 'location', 'price', 'size', 'bedrooms', 'category', 'facing', 'floor', 'posted'];

function sizeAndType(deal: DealerDeal): string {
  const parts = [deal.category, deal.bhk ? `${deal.bhk} BHK` : null, deal.sizeSqYd ? `${deal.sizeSqYd} yd` : null];
  return parts.filter(Boolean).join(' · ') || '—';
}

function price(deal: DealerDeal): string {
  if (deal.priceMinLakh === null) return '—';
  const low = formatIndianPrice(deal.priceMinLakh * 100_000);
  if (deal.priceMaxLakh === null || deal.priceMaxLakh === deal.priceMinLakh) return low;
  return `${low} – ${formatIndianPrice(deal.priceMaxLakh * 100_000)}`;
}

export function DealerDealsTab({ module, recordId, tab, columns: savedColumns }: { module: string; recordId: string; tab: DealTabKey; columns?: string[] }): JSX.Element {
  const [message, setMessage] = useState<MessageToShow | null>(null);
  const [search, setSearch] = useState('');
  const [locality, setLocality] = useState('');
  const [sort, setSort] = useState<{ key: AssociateDealColumn; direction: 'asc' | 'desc' }>({ key: 'posted', direction: 'desc' });
  const { data, isLoading, error } = useQuery({
    queryKey: dealsQueryKey(recordId),
    queryFn: () => api.dealerDeals(module, recordId),
    staleTime: 60_000,
  });
  const allRows = data?.[LIST_OF[tab]] ?? [];
  const places = [...new Set(allRows.flatMap((deal) => deal.places))].sort((a, b) => a.localeCompare(b));
  const visibleColumns = useMemo(() => {
    const valid = new Set<string>(ASSOCIATE_DEAL_COLUMNS.map((column) => column.key));
    const chosen = (savedColumns ?? DEFAULT_ASSOCIATE_DEAL_COLUMNS).filter((column): column is AssociateDealColumn => valid.has(column));
    return chosen.length ? chosen : DEFAULT_ASSOCIATE_DEAL_COLUMNS;
  }, [savedColumns]);
  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const matched = allRows.filter((deal) => {
      const haystack = [deal.summary, deal.body, deal.category, deal.project, deal.facing, deal.floor, ...deal.places, ...deal.groups].filter(Boolean).join(' ').toLocaleLowerCase();
      return (!needle || haystack.includes(needle)) && (!locality || deal.places.includes(locality));
    });
    const scalar = (deal: DealerDeal): string | number => {
      switch (sort.key) {
        case 'property': return `${deal.category ?? ''} ${deal.summary}`.toLocaleLowerCase();
        case 'location': return deal.places.join(', ').toLocaleLowerCase();
        case 'price': return deal.priceMinLakh ?? -1;
        case 'size': return deal.sizeSqYd ?? -1;
        case 'bedrooms': return deal.bhk ?? -1;
        case 'category': return (deal.category ?? '').toLocaleLowerCase();
        case 'facing': return (deal.facing ?? '').toLocaleLowerCase();
        case 'floor': return (deal.floor ?? '').toLocaleLowerCase();
        case 'posted': return deal.postedAt ? new Date(deal.postedAt).getTime() : 0;
      }
    };
    return matched.sort((a, b) => {
      const av = scalar(a); const bv = scalar(b);
      const order = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.direction === 'asc' ? order : -order;
    });
  }, [allRows, locality, search, sort]);

  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>;
  if (error) return <p className="text-sm text-negative">Could not load this dealer&apos;s deals: {(error as Error).message}</p>;

  if (!allRows.length) return <EmptyState title="Nothing here yet" body={COPY[tab].empty} />;

  const toggleSort = (key: AssociateDealColumn): void => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }));

  const cell = (deal: DealerDeal, key: AssociateDealColumn): JSX.Element | string => {
    switch (key) {
      case 'property': return <><p className="font-semibold">{sizeAndType(deal)}</p><p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-muted">{deal.summary || deal.body}</p></>;
      case 'location': return deal.places.length ? <span className="flex flex-wrap gap-1">{deal.places.map((place) => <Badge key={place}>{place}</Badge>)}</span> : '—';
      case 'price': return price(deal);
      case 'size': return deal.sizeSqYd ? `${deal.sizeSqYd} Sq. Yd.` : '—';
      case 'bedrooms': return deal.bhk ? `${deal.bhk} BHK` : '—';
      case 'category': return deal.category ?? '—';
      case 'facing': return deal.facing ?? '—';
      case 'floor': return [deal.floor, deal.project].filter(Boolean).join(' · ') || '—';
      case 'posted': return <>{deal.postedAt ? relativeTime(deal.postedAt) : '—'}<br /><span className="text-muted">{deal.groups.join(', ')}{deal.seenCount > 1 ? ` · ${deal.seenCount}×` : ''}</span></>;
    }
  };

  return (
    <div className="space-y-2" data-testid="associate-deals-table">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-white p-2 dark:bg-slate-900">
        <label className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
          <input aria-label="Search this Associate's deals" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search property, locality, category, group…" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
        <label className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs">
          <SlidersHorizontal className="h-3.5 w-3.5 text-muted" />
          <select aria-label="Filter deals by locality" value={locality} onChange={(event) => setLocality(event.target.value)} className="bg-transparent outline-none">
            <option value="">All localities</option>{places.map((place) => <option key={place} value={place}>{place}</option>)}
          </select>
        </label>
        <span className="ml-auto text-xs text-muted">{rows.length} of {allRows.length} records</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-white dark:bg-slate-900">
        <table className="w-full min-w-[34rem] text-left text-xs">
          <thead className="list-head">
            <tr>
              {visibleColumns.map((key) => {
                const column = ASSOCIATE_DEAL_COLUMNS.find((item) => item.key === key)!;
                const label = key === 'price' ? COPY[tab].price : column.label;
                return <th key={key} aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'} className="whitespace-nowrap px-3 py-2 font-semibold">
                  <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 hover:text-brand-700">{label}<ArrowUpDown className="h-3 w-3 text-muted" /></button>
                </th>;
              })}
              <th className="px-3 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((deal) => (
              <tr
                key={deal.id}
                className="border-t border-[var(--border)] align-top hover:bg-[var(--surface-muted)]"
              >
                {visibleColumns.map((key) => <td key={key} className={cn('px-3 py-2', key === 'price' && 'whitespace-nowrap font-semibold', key === 'posted' && 'text-muted')}>
                  {key === 'property' ? <>{cell(deal, key)}<span className="mt-1 inline-flex gap-3">
                    <button type="button" onClick={() => setMessage({ postId: deal.postId, body: deal.body, posterName: null, posterPhone: null, groups: deal.groups, postedAt: deal.postedAt, highlight: deal.summary })} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">Read full message</button>
                    <Link to={`/market?deal=${deal.postId}`} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">Who fits this? →</Link>
                  </span></> : cell(deal, key)}
                </td>)}
                <td className="whitespace-nowrap px-3 py-2">
                  <button type="button" onClick={() => setMessage({ postId: deal.postId, body: deal.body, posterName: null, posterPhone: null, groups: deal.groups, postedAt: deal.postedAt, highlight: deal.summary })} className="font-semibold text-brand-700 hover:underline dark:text-brand-300">Open post</button>
                  <Link to={`/market?deal=${deal.postId}`} className="ml-2 font-semibold text-brand-700 hover:underline dark:text-brand-300">Match</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-sm text-muted">No deals match these filters.</p>}
      </div>
      {data?.truncated && <p className="text-xs text-muted">Showing the newest {rows.length}.</p>}
      <DealMessageDialog message={message} onClose={() => setMessage(null)} />
    </div>
  );
}
