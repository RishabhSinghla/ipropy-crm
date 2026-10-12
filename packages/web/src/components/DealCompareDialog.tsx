/**
 * Two to four of a dealer's properties side by side, so a rep choosing between
 * them reads one grid and not four rows scrolled apart. A row whose values
 * differ is tinted, because the difference is the reason somebody compared.
 */
import { type JSX } from 'react';
import { formatIndianPrice } from '@ipropy/shared';
import type { DealerDeal } from '../lib/api';
import { floorAndPortion, postedDate } from '../lib/dealGrid';
import { Modal } from './ui';
import { cn } from '../lib/utils';

export const COMPARE_LIMIT = 4;

function price(deal: DealerDeal): string {
  if (deal.priceMinLakh === null) return '—';
  const low = formatIndianPrice(deal.priceMinLakh * 100_000);
  if (deal.priceMaxLakh === null || deal.priceMaxLakh === deal.priceMinLakh) return low;
  return `${low} – ${formatIndianPrice(deal.priceMaxLakh * 100_000)}`;
}

const ROWS: Array<{ label: string; read: (deal: DealerDeal) => string }> = [
  { label: 'For Sale / For Rent', read: (d) => (d.purpose === 'rent' ? 'For Rent' : 'For Sale') },
  { label: 'House / Unit No.', read: (d) => d.houseNo || '—' },
  { label: 'Locality / Sector', read: (d) => d.places.join(', ') || '—' },
  { label: 'Price', read: price },
  { label: 'Size (Sq. Yd.)', read: (d) => (d.sizeSqYd ? String(d.sizeSqYd) : '—') },
  { label: 'Bedrooms (BHK)', read: (d) => (d.bhk ? String(d.bhk) : '—') },
  { label: 'Category', read: (d) => d.category || '—' },
  { label: 'Facing', read: (d) => d.facing || '—' },
  { label: 'Floor / Portion', read: (d) => floorAndPortion(d) || '—' },
  { label: 'Property Status', read: (d) => d.propertyStatus || '—' },
  { label: 'Posted Date', read: (d) => postedDate(d.postedAt) },
];

export default function DealCompareDialog({ deals, onClose }: { deals: DealerDeal[]; onClose: () => void }): JSX.Element {
  return (
    <Modal open={deals.length > 0} onClose={onClose} title={`Compare ${deals.length} properties`} size="lg">
      <div className="overflow-x-auto" data-testid="deal-compare-table">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              <th className="w-40 px-3 py-2 font-semibold text-muted">&nbsp;</th>
              {deals.map((deal) => <th key={deal.key} className="px-3 py-2 font-semibold">{deal.houseNo || deal.summary.slice(0, 30) || 'Property'}</th>)}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => {
              const values = deals.map(row.read);
              const differs = new Set(values).size > 1;
              return (
                <tr key={row.label} className={cn('border-t border-[var(--border)]', differs && 'bg-amber-50 dark:bg-slate-800')}>
                  <th className="px-3 py-2 font-medium text-muted">{row.label}</th>
                  {values.map((value, index) => <td key={deals[index].key} className="px-3 py-2">{value}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
