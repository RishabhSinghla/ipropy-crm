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
import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatIndianPrice, relativeTime } from '@ipropy/shared';
import { api, type DealerDeal, type DealerDeals } from '../lib/api';
import { Badge, EmptyState, Spinner } from './ui';
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

export function DealerDealsTab({ module, recordId, tab }: { module: string; recordId: string; tab: DealTabKey }): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: dealsQueryKey(recordId),
    queryFn: () => api.dealerDeals(module, recordId),
    staleTime: 60_000,
  });
  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>;
  if (error) return <p className="text-sm text-negative">Could not load this dealer&apos;s deals: {(error as Error).message}</p>;
  const rows = data?.[LIST_OF[tab]] ?? [];
  if (!rows.length) return <EmptyState title="Nothing here yet" body={COPY[tab].empty} />;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-white dark:bg-slate-900">
        <table className="w-full min-w-[34rem] text-left text-xs">
          <thead className="list-head">
            <tr>
              <th className="px-3 py-2 font-semibold">Property</th>
              <th className="px-3 py-2 font-semibold">Where</th>
              <th className="px-3 py-2 font-semibold">{COPY[tab].price}</th>
              <th className="px-3 py-2 font-semibold">Posted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((deal) => (
              <tr key={deal.id} className="border-t border-[var(--border)] align-top">
                <td className="px-3 py-2">
                  <p className="font-semibold">{sizeAndType(deal)}</p>
                  <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-muted">{deal.body}</p>
                  <Link to={`/market?deal=${deal.id}`} className="mt-1 inline-block font-semibold text-brand-700 hover:underline dark:text-brand-300">
                    Who fits this? →
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap gap-1">{deal.places.length ? deal.places.slice(0, 3).map((place) => <Badge key={place}>{place}</Badge>) : '—'}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-semibold">{price(deal)}</td>
                <td className="px-3 py-2 text-muted">
                  {deal.postedAt ? relativeTime(deal.postedAt) : '—'}
                  <br />
                  {deal.groups.join(', ')}{deal.seenCount > 1 ? ` · ${deal.seenCount}×` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data?.truncated && <p className="text-xs text-muted">Showing the newest {rows.length}.</p>}
    </div>
  );
}
