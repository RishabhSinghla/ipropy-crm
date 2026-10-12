/**
 * What the Associates deal tables decide, kept out of the component so a `node`
 * test can read it: which columns exist, how a column filters, how a column sorts.
 *
 * The screen is `components/DealerDeals.tsx`; this file draws nothing.
 */
import type { DealerDeal } from './api';

/** Every column the table can draw. Admin -> Layouts chooses which, and in what order. */
export const DEAL_COLUMNS = [
  { key: 'property', label: 'Property / Requirement', width: 260 },
  { key: 'deal_type', label: 'For Sale / For Rent', width: 120 },
  { key: 'house_no', label: 'House / Unit No.', width: 110 },
  { key: 'location', label: 'Locality / Sector', width: 170 },
  { key: 'price', label: 'Price', width: 130 },
  { key: 'size', label: 'Size (Sq. Yd.)', width: 110 },
  { key: 'bedrooms', label: 'Bedrooms (BHK)', width: 110 },
  { key: 'category', label: 'Category', width: 130 },
  { key: 'facing', label: 'Facing', width: 90 },
  { key: 'floor', label: 'Floor / Portion', width: 130 },
  { key: 'posted', label: 'Posted Date', width: 110 },
] as const;

export type DealColumn = typeof DEAL_COLUMNS[number]['key'];

/** What an unsaved layout shows: every column, the new ones beside the old. */
export const DEFAULT_DEAL_COLUMNS: DealColumn[] = DEAL_COLUMNS.map((column) => column.key);

/** The saved choice, cleaned: anything this build cannot draw is dropped, and nothing left means the default. */
export function chosenColumns(saved: string[] | undefined): DealColumn[] {
  if (!saved) return DEFAULT_DEAL_COLUMNS;
  const valid = new Set<string>(DEAL_COLUMNS.map((column) => column.key));
  const kept = [...new Set(saved)].filter((key): key is DealColumn => valid.has(key));
  return kept.length ? kept : DEFAULT_DEAL_COLUMNS;
}

/** "Budget" where the row is a wish and "Asking" where it is stock, rent where it is a let. */
export function priceLabel(tab: 'availability' | 'requirement'): string {
  return tab === 'requirement' ? 'Budget' : 'Price';
}

export interface DealFilters {
  property: string;
  dealType: '' | 'sale' | 'rent';
  houseNo: string;
  location: string;
  /** Lakh. Empty is no limit. */
  priceMin: string;
  priceMax: string;
  sizeMin: string;
  sizeMax: string;
  bedrooms: string;
  category: string;
  facing: string;
  floor: string;
  /** Show only what was posted within this many days; empty is any time. */
  postedWithinDays: string;
}

export const NO_FILTERS: DealFilters = {
  property: '', dealType: '', houseNo: '', location: '', priceMin: '', priceMax: '', sizeMin: '', sizeMax: '',
  bedrooms: '', category: '', facing: '', floor: '', postedWithinDays: '',
};

export function filterCount(filters: DealFilters): number {
  return Object.values(filters).filter((value) => value !== '').length;
}

const lower = (value: string | null | undefined): string => (value ?? '').toLocaleLowerCase();
const has = (needle: string, ...haystack: Array<string | null | undefined>): boolean =>
  !needle.trim() || haystack.some((text) => lower(text).includes(needle.trim().toLocaleLowerCase()));
const number = (value: string): number | null => (value.trim() === '' || Number.isNaN(Number(value)) ? null : Number(value));

/** A deal's price range overlaps the asked range. A deal with no price is hidden once a price is asked for. */
function priceFits(deal: DealerDeal, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true;
  if (deal.priceMinLakh === null) return false;
  const low = deal.priceMinLakh;
  const high = deal.priceMaxLakh ?? deal.priceMinLakh;
  return (max === null || low <= max) && (min === null || high >= min);
}

function sizeFits(deal: DealerDeal, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true;
  if (deal.sizeSqYd === null) return false;
  return (min === null || deal.sizeSqYd >= min) && (max === null || deal.sizeSqYd <= max);
}

export function floorAndPortion(deal: DealerDeal): string {
  return [deal.floor, deal.portion].filter(Boolean).join(' · ');
}

export function filterDeals(deals: DealerDeal[], filters: DealFilters, now = Date.now()): DealerDeal[] {
  const days = number(filters.postedWithinDays);
  return deals.filter((deal) => {
    if (filters.dealType && deal.purpose !== filters.dealType) return false;
    if (!has(filters.property, deal.summary, deal.body, deal.project, ...deal.groups)) return false;
    if (!has(filters.houseNo, deal.houseNo)) return false;
    if (!has(filters.location, ...deal.places)) return false;
    if (!priceFits(deal, number(filters.priceMin), number(filters.priceMax))) return false;
    if (!sizeFits(deal, number(filters.sizeMin), number(filters.sizeMax))) return false;
    if (filters.bedrooms && String(deal.bhk ?? '') !== filters.bedrooms) return false;
    if (filters.category && lower(deal.category) !== lower(filters.category)) return false;
    if (filters.facing && lower(deal.facing) !== lower(filters.facing)) return false;
    if (!has(filters.floor, deal.floor, deal.portion)) return false;
    if (days !== null) {
      if (!deal.postedAt) return false;
      if (now - new Date(deal.postedAt).getTime() > days * 86_400_000) return false;
    }
    return true;
  });
}

export type SortState = { key: DealColumn; direction: 'asc' | 'desc' };

function sortValue(deal: DealerDeal, key: DealColumn): string | number {
  switch (key) {
    case 'property': return lower(`${deal.category ?? ''} ${deal.summary}`);
    case 'deal_type': return deal.purpose;
    case 'house_no': return lower(deal.houseNo);
    case 'location': return lower(deal.places.join(', '));
    case 'price': return deal.priceMinLakh ?? -1;
    case 'size': return deal.sizeSqYd ?? -1;
    case 'bedrooms': return deal.bhk ?? -1;
    case 'category': return lower(deal.category);
    case 'facing': return lower(deal.facing);
    case 'floor': return lower(floorAndPortion(deal));
    case 'posted': return deal.postedAt ? new Date(deal.postedAt).getTime() : 0;
  }
}

export function sortDeals(deals: DealerDeal[], sort: SortState): DealerDeal[] {
  return [...deals].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    const order = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
    return sort.direction === 'asc' ? order : -order;
  });
}

/** The two lists the tabs show, each merged from the server's four. */
export function dealsForTab(
  data: { forSale: DealerDeal[]; forRent: DealerDeal[]; buyerRequirements: DealerDeal[]; tenantRequirements: DealerDeal[] } | undefined,
  tab: 'availability' | 'requirement',
): DealerDeal[] {
  if (!data) return [];
  return tab === 'availability' ? [...data.forSale, ...data.forRent] : [...data.buyerRequirements, ...data.tenantRequirements];
}

/** Which list each of the two deal tabs shows. String keys, so this file need not import the tab type. */
export const DEAL_TAB_OF: Record<string, 'availability' | 'requirement'> = {
  deals_availability: 'availability',
  deals_requirement: 'requirement',
};

/** The number on a tab: nothing when empty, and "N+" when the server cut a list at its newest 100. */
export function tabCountLabel(
  data: { forSale: DealerDeal[]; forRent: DealerDeal[]; buyerRequirements: DealerDeal[]; tenantRequirements: DealerDeal[]; truncated: boolean } | undefined,
  tab: 'availability' | 'requirement',
): string | null {
  const count = dealsForTab(data, tab).length;
  if (!count) return null;
  return data?.truncated ? `${count}+` : String(count);
}

/** The distinct values a dropdown filter offers, as the rows spell them, in reading order. */
export function distinct(values: Array<string | number | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const text = String(value);
    if (!seen.has(text.toLocaleLowerCase())) seen.set(text.toLocaleLowerCase(), text);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** The date alone — "10 Oct 2026" — never the time, the group or how many times it was seen. */
export function postedDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

/** What the form edits. Excluded on purpose: the dealer's own Mobile, Assigned To, Contact Type and Operating Location — they belong to the Associate, not to one property. */
export const DEAL_FORM_FIELDS = [
  { key: 'deal_type', label: 'For Sale / For Rent' },
  { key: 'house_no', label: 'House / Unit No.' },
  { key: 'locality', label: 'Locality / Sector' },
  { key: 'price', label: 'Price (₹ lakh)' },
  { key: 'size', label: 'Size (Sq. Yd.)' },
  { key: 'bedrooms', label: 'Bedrooms (BHK)' },
  { key: 'category', label: 'Category' },
  { key: 'facing', label: 'Facing' },
  { key: 'floor', label: 'Floor' },
  { key: 'portion', label: 'Portion' },
  { key: 'next_followup', label: 'Next Follow Up' },
  { key: 'property_status', label: 'Property Status' },
  { key: 'lost_reason', label: 'Lost Reason' },
  { key: 'source', label: 'Source' },
] as const;

export type DealFormField = typeof DEAL_FORM_FIELDS[number]['key'];
export const DEFAULT_DEAL_FORM_FIELDS: DealFormField[] = DEAL_FORM_FIELDS.map((field) => field.key);

/** A field an admin added to the form: stored under `extra`, so it needs no migration. */
export interface CustomDealField { key: string; label: string }

/** A slug the server accepts as an `extra` key, unique among the keys already used. */
export function customKeyFor(label: string, taken: string[]): string {
  const base = label.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 36) || 'field';
  let key = base;
  for (let n = 2; taken.includes(key); n += 1) key = `${base}_${n}`;
  return key;
}

/** The saved form, cleaned against what this build can draw. Nothing saved means every built-in field. */
export function chosenFormFields(saved: string[] | undefined): DealFormField[] {
  if (!saved) return DEFAULT_DEAL_FORM_FIELDS;
  const valid = new Set<string>(DEAL_FORM_FIELDS.map((field) => field.key));
  return [...new Set(saved)].filter((key): key is DealFormField => valid.has(key));
}
