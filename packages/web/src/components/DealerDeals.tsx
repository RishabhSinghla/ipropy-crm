/**
 * An Associate's two deal lists — Availability and Requirement — what this dealer
 * has posted in the WhatsApp groups, as a working table rather than text in a
 * comment.
 *
 * Both tabs read one answer (`['market', 'record-deals', id]`), so opening the
 * second asks nothing again and the number on a tab and the rows under it cannot
 * disagree. Each row is one property: tick it, filter by any column, open its own
 * form on the right and fill the details in, compare it with another, duplicate it
 * or take it off the list. The deals are the Dealer groups page's own rows, stored
 * once, so a row links back there for "which of our contacts want this?".
 *
 * The pure decisions — columns, filters, sorting — are `lib/dealGrid.ts`.
 */
import { type JSX, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MARKET_FEED_DAYS, formatIndianPrice } from '@ipropy/shared';
import { ArrowUpDown, Scale, X } from 'lucide-react';
import { api, type DealerDeal, type DealerDealPatch } from '../lib/api';
import {
  chosenColumns, chosenFormFields, DEAL_COLUMNS, distinct, filterCount, filterDeals, floorAndPortion, NO_FILTERS,
  postedDate, priceLabel, sortDeals, dealsForTab, type CustomDealField, type DealColumn, type DealFilters, type SortState,
} from '../lib/dealGrid';
import DealMessageDialog, { type MessageToShow } from './DealMessageDialog';
import { DealRowActions } from './DealRowActions';
import DealCompareDialog, { COMPARE_LIMIT } from './DealCompareDialog';
import DealDetailForm from './DealDetailForm';
import SearchableSelect from './SearchableSelect';
import { Badge, ConfirmDialog, EmptyState, Spinner } from './ui';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import type { DealTabKey } from '../lib/splitViewLayout';

export const dealsQueryKey = (recordId: string) => ['market', 'record-deals', recordId] as const;

const COPY: Record<'availability' | 'requirement', string> = {
  availability: 'This dealer has not posted anything to sell or let in the groups you have added.',
  requirement: 'No buyer or tenant requirements from this dealer yet.',
};

const CHECK_COLUMN = 36;
const ACTIONS_COLUMN = 56;
// The tick box and the buttons stay in view while the columns between them scroll. A pinned cell needs a background of its own, or the cells sliding under it show through.
const PIN_LEFT = 'sticky left-0 z-10 bg-white dark:bg-slate-900';
const PIN_RIGHT = 'sticky right-0 z-10 bg-white dark:bg-slate-900';
const FILTER_SELECT = 'h-7 min-h-0 px-1.5 py-0 text-[11px]';
const FILTER_BOX = 'h-7 w-full min-w-0 rounded border border-[var(--border)] bg-white px-1.5 text-[11px] outline-none focus:border-brand-500 dark:bg-slate-900';

const widthOf = (key: DealColumn): number => DEAL_COLUMNS.find((column) => column.key === key)!.width;

function price(deal: DealerDeal): string {
  if (deal.priceMinLakh === null) return '—';
  const low = formatIndianPrice(deal.priceMinLakh * 100_000);
  if (deal.priceMaxLakh === null || deal.priceMaxLakh === deal.priceMinLakh) return low;
  return `${low} – ${formatIndianPrice(deal.priceMaxLakh * 100_000)}`;
}

function sizeAndType(deal: DealerDeal): string {
  const parts = [deal.category, deal.bhk ? `${deal.bhk} BHK` : null, deal.sizeSqYd ? `${deal.sizeSqYd} yd` : null];
  return parts.filter(Boolean).join(' · ');
}

/** What a cell says, as plain text: it is shown on one line and is also its own hover tooltip. */
function cellText(deal: DealerDeal, column: DealColumn): string {
  switch (column) {
    case 'property': return [sizeAndType(deal), deal.summary || deal.body].filter(Boolean).join(' — ').replace(/\s+/g, ' ') || '—';
    case 'deal_type': return deal.purpose === 'rent' ? 'For Rent' : 'For Sale';
    case 'house_no': return deal.houseNo || '—';
    case 'location': return deal.places.join(', ') || '—';
    case 'price': return price(deal);
    case 'size': return deal.sizeSqYd ? `${deal.sizeSqYd} Sq. Yd.` : '—';
    case 'bedrooms': return deal.bhk ? `${deal.bhk} BHK` : '—';
    case 'category': return deal.category || '—';
    case 'facing': return deal.facing || '—';
    case 'floor': return floorAndPortion(deal) || '—';
    case 'posted': return postedDate(deal.postedAt);
  }
}

function detailsToCopy(deal: DealerDeal): string {
  const lines = DEAL_COLUMNS.filter((column) => column.key !== 'property').map((column) => `${column.label}: ${cellText(deal, column.key)}`);
  return `${lines.join('\n')}\n\n${deal.summary || deal.body}`;
}

function messageOf(deal: DealerDeal): MessageToShow {
  return { postId: deal.postId, body: deal.body, posterName: null, posterPhone: null, groups: deal.groups, postedAt: deal.postedAt, highlight: deal.summary };
}

function FilterCell({ column, filters, set, rows }: { column: DealColumn; filters: DealFilters; set: (patch: Partial<DealFilters>) => void; rows: DealerDeal[] }): JSX.Element {
  const text = (key: 'property' | 'houseNo' | 'location' | 'floor', label: string): JSX.Element => (
    <input aria-label={`Filter by ${label}`} className={FILTER_BOX} placeholder="Filter" value={filters[key]} onChange={(event) => set({ [key]: event.target.value })} />
  );
  const range = (low: 'priceMin' | 'sizeMin', high: 'priceMax' | 'sizeMax', label: string): JSX.Element => (
    <div className="flex gap-1">
      <input aria-label={`${label} from`} type="number" min={0} className={FILTER_BOX} placeholder="From" value={filters[low]} onChange={(event) => set({ [low]: event.target.value })} />
      <input aria-label={`${label} to`} type="number" min={0} className={FILTER_BOX} placeholder="To" value={filters[high]} onChange={(event) => set({ [high]: event.target.value })} />
    </div>
  );
  const pick = (key: 'bedrooms' | 'category' | 'facing', label: string, options: string[]): JSX.Element => (
    <SearchableSelect ariaLabel={`Filter by ${label}`} className={FILTER_SELECT} fullWidth value={filters[key]} onChange={(next) => set({ [key]: next })}
      options={[{ value: '', label: 'All' }, ...options.map((option) => ({ value: option, label: option }))]} />
  );
  switch (column) {
    case 'property': return text('property', 'property');
    case 'deal_type': return (
      <SearchableSelect ariaLabel="Filter by For Sale or For Rent" className={FILTER_SELECT} fullWidth value={filters.dealType} onChange={(next) => set({ dealType: next as DealFilters['dealType'] })}
        options={[{ value: '', label: 'All' }, { value: 'sale', label: 'For Sale' }, { value: 'rent', label: 'For Rent' }]} />
    );
    case 'house_no': return text('houseNo', 'house number');
    case 'location': return text('location', 'locality');
    case 'price': return range('priceMin', 'priceMax', 'Price (₹ lakh)');
    case 'size': return range('sizeMin', 'sizeMax', 'Size');
    case 'bedrooms': return pick('bedrooms', 'bedrooms', distinct(rows.map((row) => row.bhk)));
    case 'category': return pick('category', 'category', distinct(rows.map((row) => row.category)));
    case 'facing': return pick('facing', 'facing', distinct(rows.map((row) => row.facing)));
    case 'floor': return text('floor', 'floor or portion');
    case 'posted': return (
      <SearchableSelect ariaLabel="Filter by posted date" className={FILTER_SELECT} fullWidth value={filters.postedWithinDays} onChange={(next) => set({ postedWithinDays: next })}
        options={[{ value: '', label: 'Any time' }, { value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: String(MARKET_FEED_DAYS), label: `${MARKET_FEED_DAYS} days` }]} />
    );
  }
}

export function DealerDealsTab({ module, recordId, tab, columns: savedColumns, formFields: savedFormFields, customFields = [] }: {
  module: string;
  recordId: string;
  tab: DealTabKey;
  columns?: string[];
  formFields?: string[];
  customFields?: CustomDealField[];
}): JSX.Element {
  const which = tab === 'deals_availability' ? 'availability' : 'requirement';
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<MessageToShow | null>(null);
  const [filters, setFilters] = useState<DealFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortState>({ key: 'posted', direction: 'desc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [comparing, setComparing] = useState<DealerDeal[]>([]);
  const [removing, setRemoving] = useState<DealerDeal[]>([]);

  const { data, isLoading, error } = useQuery({
    queryKey: dealsQueryKey(recordId),
    queryFn: () => api.dealerDeals(module, recordId),
    staleTime: 60_000,
  });
  const allRows = useMemo(() => dealsForTab(data, which), [data, which]);
  const rows = useMemo(() => sortDeals(filterDeals(allRows, filters), sort), [allRows, filters, sort]);
  const visibleColumns = useMemo(() => chosenColumns(savedColumns), [savedColumns]);

  // The Matching button's number, asked once for the posts on screen (the server caps one ask).
  const postIds = useMemo(() => [...new Set(rows.map((row) => row.postId))].slice(0, 40), [rows]);
  const { data: matchCounts } = useQuery({
    queryKey: ['market', 'deal-match-counts', postIds.join(',')],
    queryFn: () => api.dealMatchCounts(postIds),
    enabled: postIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: dealsQueryKey(recordId) });
  const save = useMutation({
    mutationFn: ({ deal, patch }: { deal: DealerDeal; patch: DealerDealPatch }) => api.updateDealerDeal(module, recordId, deal.ref, patch),
    onSuccess: refresh,
    onError: (err: Error) => toast.error('Could not save', err.message),
  });
  const duplicate = useMutation({
    mutationFn: (deals: DealerDeal[]) => Promise.all(deals.map((deal) => api.duplicateDealerDeal(module, recordId, deal.ref))),
    onSuccess: (_ids, deals) => { toast.success(deals.length === 1 ? 'Property duplicated' : `${deals.length} properties duplicated`); void refresh(); },
    onError: (err: Error) => toast.error('Could not duplicate', err.message),
  });
  const remove = useMutation({
    mutationFn: (deals: DealerDeal[]) => Promise.all(deals.map((deal) => api.deleteDealerDeal(module, recordId, deal.ref))),
    onSuccess: (_done, deals) => {
      const gone = new Set(deals.map((deal) => deal.key));
      setSelected((current) => new Set([...current].filter((key) => !gone.has(key))));
      if (openKey && gone.has(openKey)) setOpenKey(null);
      toast.success(deals.length === 1 ? 'Property removed' : `${deals.length} properties removed`);
      void refresh();
    },
    onError: (err: Error) => toast.error('Could not remove', err.message),
  });

  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>;
  if (error) return <p className="text-sm text-negative">Could not load this dealer&apos;s deals: {(error as Error).message}</p>;
  if (!allRows.length) return <EmptyState title="Nothing here yet" body={COPY[which]} />;

  const openDeal = rows.find((row) => row.key === openKey) ?? null;
  const ticked = rows.filter((row) => selected.has(row.key));
  const allTicked = rows.length > 0 && ticked.length === rows.length;
  const tableWidth = CHECK_COLUMN + ACTIONS_COLUMN + visibleColumns.reduce((sum, key) => sum + widthOf(key), 0);

  const setFilter = (patch: Partial<DealFilters>): void => setFilters((current) => ({ ...current, ...patch }));
  const toggle = (key: string): void => setSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const toggleSort = (key: DealColumn): void => setSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));

  /** Compare takes the ticked rows plus this one, so one press on a row beside a ticked one is enough. */
  const compare = (deal: DealerDeal): void => {
    const others = ticked.filter((row) => row.key !== deal.key);
    if (!others.length) {
      setSelected((current) => new Set(current).add(deal.key));
      toast.info('Tick one more property, then press Compare');
      return;
    }
    if (others.length + 1 > COMPARE_LIMIT) { toast.error(`Compare up to ${COMPARE_LIMIT} at a time`); return; }
    setComparing([...others, deal]);
  };
  const copy = (deal: DealerDeal): void => {
    void navigator.clipboard?.writeText(detailsToCopy(deal)).then(() => toast.success('Details copied'), () => toast.error('Could not copy'));
  };

  return (
    <div className="space-y-2" data-testid="associate-deals-table">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 py-2 text-xs dark:bg-slate-900">
        <span className="text-muted" data-testid="deal-count">{rows.length} of {allRows.length} {which === 'availability' ? 'properties' : 'requirements'}</span>
        {filterCount(filters) > 0 && <button type="button" onClick={() => setFilters(NO_FILTERS)} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline dark:text-brand-300"><X className="h-3 w-3" />Clear {filterCount(filters)} filter{filterCount(filters) === 1 ? '' : 's'}</button>}
        {ticked.length > 0 && (
          <span className="ml-auto flex items-center gap-2" data-testid="deal-bulk-bar">
            <span className="font-semibold">{ticked.length} selected</span>
            <button type="button" className="btn-secondary h-7 px-2 text-xs" disabled={ticked.length < 2 || ticked.length > COMPARE_LIMIT} title={ticked.length < 2 ? 'Select at least two' : undefined} onClick={() => setComparing(ticked)}><Scale className="h-3.5 w-3.5" />Compare</button>
            <button type="button" className="btn-secondary h-7 px-2 text-xs" disabled={duplicate.isPending} onClick={() => duplicate.mutate(ticked)}>Duplicate</button>
            <button type="button" className="btn-secondary h-7 px-2 text-xs text-negative" onClick={() => setRemoving(ticked)}>Delete</button>
            <button type="button" className="h-7 px-1 text-muted hover:underline" onClick={() => setSelected(new Set())}>Clear</button>
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-[var(--border)] bg-white dark:bg-slate-900">
          <table className="table-fixed text-left text-xs" style={{ width: tableWidth }}>
            <colgroup>
              <col style={{ width: CHECK_COLUMN }} />
              {visibleColumns.map((key) => <col key={key} style={{ width: widthOf(key) }} />)}
              <col style={{ width: ACTIONS_COLUMN }} />
            </colgroup>
            <thead className="list-head">
              <tr>
                <th className={cn('px-3 py-2', PIN_LEFT)}><input type="checkbox" aria-label="Select all shown properties" checked={allTicked} onChange={() => setSelected(allTicked ? new Set() : new Set(rows.map((row) => row.key)))} className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600" data-testid="deal-select-all" /></th>
                {visibleColumns.map((key) => {
                  const column = DEAL_COLUMNS.find((item) => item.key === key)!;
                  return (
                    <th key={key} aria-sort={sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} className="overflow-hidden whitespace-nowrap px-3 py-2 font-semibold">
                      <button type="button" onClick={() => toggleSort(key)} className="inline-flex max-w-full items-center gap-1 hover:text-brand-700"><span className="truncate">{key === 'price' ? priceLabel(which) : column.label}</span><ArrowUpDown className="h-3 w-3 shrink-0 text-muted" /></button>
                    </th>
                  );
                })}
                <th className={cn('px-3 py-2 font-semibold', PIN_RIGHT)}>Actions</th>
              </tr>
              <tr data-testid="deal-filters" className="border-t border-[var(--border)]">
                <th className={cn('px-3 py-1.5', PIN_LEFT)} />
                {visibleColumns.map((key) => <th key={key} className="px-2 py-1.5 font-normal"><FilterCell column={key} filters={filters} set={setFilter} rows={allRows} /></th>)}
                <th className={cn('px-2 py-1.5', PIN_RIGHT)} />
              </tr>
            </thead>
            <tbody>
              {rows.map((deal) => {
                const isOpen = deal.key === openKey;
                return (
                  <tr
                    key={deal.key}
                    data-testid="deal-row"
                    onClick={() => setOpenKey(isOpen ? null : deal.key)}
                    className={cn('cursor-pointer border-t border-[var(--border)] hover:bg-[var(--surface-muted)]', isOpen && 'bg-brand-50 dark:bg-brand-950')}
                  >
                    <td className={cn('px-3 py-1.5', PIN_LEFT, isOpen && 'bg-brand-50 dark:bg-brand-950')} onClick={(event) => event.stopPropagation()}>
                      <input type="checkbox" aria-label="Select this property" checked={selected.has(deal.key)} onChange={() => toggle(deal.key)} className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600" data-testid="deal-select" />
                    </td>
                    {visibleColumns.map((key) => {
                      const text = cellText(deal, key);
                      return (
                        <td key={key} title={text} className={cn('overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5', key === 'price' && 'font-semibold', key === 'posted' && 'text-muted')}>
                          {key === 'deal_type' ? <Badge>{text}</Badge> : text}
                        </td>
                      );
                    })}
                    <td className={cn('px-2 py-1', PIN_RIGHT, isOpen && 'bg-brand-50 dark:bg-brand-950')} onClick={(event) => event.stopPropagation()}>
                      <DealRowActions
                        deal={deal}
                        matchCount={matchCounts?.[deal.postId]}
                        handlers={{
                          onEdit: () => setOpenKey(deal.key),
                          onView: () => setMessage(messageOf(deal)),
                          onDuplicate: () => duplicate.mutate([deal]),
                          onDelete: () => setRemoving([deal]),
                          onCompare: () => compare(deal),
                          onCopy: () => copy(deal),
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <p className="p-6 text-center text-sm text-muted">No properties match these filters.</p>}
        </div>

        {openDeal && (
          <div className="shrink-0 xl:w-72">
            <DealDetailForm
              key={openDeal.key}
              deal={openDeal}
              fields={chosenFormFields(savedFormFields)}
              customFields={customFields}
              saving={save.isPending}
              onSave={(patch) => save.mutate({ deal: openDeal, patch })}
              onClose={() => setOpenKey(null)}
            />
          </div>
        )}
      </div>

      {data?.truncated && <p className="text-xs text-muted">Showing the newest {allRows.length}.</p>}
      <DealMessageDialog message={message} onClose={() => setMessage(null)} />
      <DealCompareDialog deals={comparing} onClose={() => setComparing([])} />
      <ConfirmDialog
        open={removing.length > 0}
        onClose={() => setRemoving([])}
        onConfirm={() => remove.mutateAsync(removing)}
        title={removing.length === 1 ? 'Remove this property?' : `Remove ${removing.length} properties?`}
        body="They leave this dealer's list. The WhatsApp message they came from is not deleted."
        confirmLabel="Remove"
        danger
      />
    </div>
  );
}
