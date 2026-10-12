import { describe, expect, it } from 'vitest';
import type { DealerDeal } from '../src/lib/api';
import {
  chosenColumns, customKeyFor, DEFAULT_DEAL_COLUMNS, dealsForTab, distinct, filterDeals, NO_FILTERS, postedDate, sortDeals,
} from '../src/lib/dealGrid';
import { arrangeRecordMenu, type MenuKey } from '../src/lib/recordMenu';
import { allSplitTabs, splitTabsFor } from '../src/lib/splitViewLayout';

const deal = (over: Partial<DealerDeal> = {}): DealerDeal => ({
  id: 'a', key: 'p:0', ref: 'post:p:0', stored: false, postId: 'p', summary: '3 BHK builder floor', body: 'whole message',
  category: 'Builder Floor', project: null, facing: 'East', floor: '2nd', bhk: 3, sizeSqYd: 200, priceMinLakh: 145,
  priceMaxLakh: 145, places: ['Greenfields Colony'], groups: ['G1'], seenCount: 1, postedAt: '2026-10-10T10:00:00Z',
  urgency: null, purpose: 'sale', houseNo: null, portion: null, nextFollowUpAt: null, propertyStatus: null,
  lostReason: null, source: null, extra: {}, ...over,
});

describe('the two tabs', () => {
  it('shows Availability and Requirement instead of four', () => {
    const keys = allSplitTabs('associates').map((tab) => tab.key);
    expect(keys).toContain('deals_availability');
    expect(keys).toContain('deals_requirement');
    expect(keys.filter((key) => key.startsWith('deals_'))).toHaveLength(2);
  });

  it('carries a layout saved with the old four tabs to the two, keeping their order', () => {
    const saved = [{ key: 'timeline' }, { key: 'deals_rent', label: 'For Rent' }, { key: 'deals_tenant' }, { key: 'deals_sale', label: 'For Sale' }, { key: 'files' }];
    const tabs = splitTabsFor('associates', saved);
    expect(tabs.map((tab) => tab.key)).toEqual(['timeline', 'deals_availability', 'deals_requirement', 'files']);
    // The old wording described half of the merged tab, so it is not carried over.
    expect(tabs[1].label).toBe('Availability');
  });

  it('carries a saved menu order across too, without a duplicate', () => {
    const available: MenuKey[] = ['comment', 'deals_availability', 'deals_requirement', 'files'];
    const saved = ['deals_buyer', 'comment', 'deals_sale', 'deals_rent'] as unknown as MenuKey[];
    expect(arrangeRecordMenu(available, saved)).toEqual(['deals_requirement', 'comment', 'deals_availability', 'files']);
  });

  it('adds the four lists into the two, with For Sale and For Rent together', () => {
    const data = { forSale: [deal({ id: '1' })], forRent: [deal({ id: '2', purpose: 'rent' }), deal({ id: '3', purpose: 'rent' })], buyerRequirements: [deal({ id: '4' })], tenantRequirements: [deal({ id: '5' })] };
    expect(dealsForTab(data, 'availability').map((row) => row.id)).toEqual(['1', '2', '3']);
    expect(dealsForTab(data, 'requirement').map((row) => row.id)).toEqual(['4', '5']);
    expect(dealsForTab(undefined, 'availability')).toEqual([]);
  });
});

describe('columns', () => {
  it('offers House No. and For Sale / For Rent, and shows them until an admin chooses', () => {
    expect(DEFAULT_DEAL_COLUMNS).toContain('house_no');
    expect(DEFAULT_DEAL_COLUMNS).toContain('deal_type');
  });

  it('keeps the admin\'s choice and order, drops what this build cannot draw, and never ends up empty', () => {
    expect(chosenColumns(['price', 'wa_post_date', 'house_no'])).toEqual(['price', 'house_no']);
    expect(chosenColumns(['nonsense'])).toEqual(DEFAULT_DEAL_COLUMNS);
  });
});

describe('the column filters', () => {
  const rows = [
    deal({ id: 'cheap', houseNo: 'B-12', priceMinLakh: 90, priceMaxLakh: 90, sizeSqYd: 150, bhk: 2, facing: 'West', category: 'Plot' }),
    deal({ id: 'mid', houseNo: 'C-31', priceMinLakh: 150, priceMaxLakh: 150, sizeSqYd: 200, bhk: 3 }),
    deal({ id: 'rent', purpose: 'rent', priceMinLakh: null, priceMaxLakh: null, places: ['Sector 15'], postedAt: '2026-08-01T00:00:00Z' }),
  ];
  const ids = (filters: Partial<typeof NO_FILTERS>): string[] => filterDeals(rows, { ...NO_FILTERS, ...filters }, new Date('2026-10-12T00:00:00Z').getTime()).map((row) => row.id);

  it('shows everything with no filter', () => expect(ids({})).toEqual(['cheap', 'mid', 'rent']));
  it('filters by house number, containing the text', () => expect(ids({ houseNo: 'b-1' })).toEqual(['cheap']));
  it('filters by locality', () => expect(ids({ location: 'sector' })).toEqual(['rent']));
  it('filters by a price range and hides a deal with no price once a price is asked for', () => {
    expect(ids({ priceMin: '100', priceMax: '160' })).toEqual(['mid']);
    expect(ids({ priceMax: '95' })).toEqual(['cheap']);
  });
  it('filters by size, bedrooms, facing, category and For Sale / For Rent', () => {
    expect(ids({ sizeMin: '180' })).toEqual(['mid', 'rent']);
    expect(ids({ bedrooms: '2' })).toEqual(['cheap']);
    expect(ids({ facing: 'west' })).toEqual(['cheap']);
    expect(ids({ category: 'plot' })).toEqual(['cheap']);
    expect(ids({ dealType: 'rent' })).toEqual(['rent']);
  });
  it('filters by how recently it was posted', () => expect(ids({ postedWithinDays: '30' })).toEqual(['cheap', 'mid']));
  it('narrows when several filters are set together', () => expect(ids({ bedrooms: '3', dealType: 'sale' })).toEqual(['mid']));
});

describe('sorting and wording', () => {
  it('sorts prices as numbers, so 90 comes before 150', () => {
    const rows = [deal({ id: 'x', priceMinLakh: 150 }), deal({ id: 'y', priceMinLakh: 90 })];
    expect(sortDeals(rows, { key: 'price', direction: 'asc' }).map((row) => row.id)).toEqual(['y', 'x']);
  });

  it('shows a posted date and nothing else', () => {
    expect(postedDate('2026-10-10T10:00:00Z')).toBe('10 Oct 2026');
    expect(postedDate(null)).toBe('—');
  });

  it('lists a dropdown\'s values once, however they were spelt', () => {
    expect(distinct(['East', 'east', null, 'West', 3, ''])).toEqual(['3', 'East', 'West']);
  });

  it('makes a key the server accepts for a field an admin adds', () => {
    expect(customKeyFor('Owner Name!', [])).toBe('owner_name');
    expect(customKeyFor('Owner Name', ['owner_name'])).toBe('owner_name_2');
    expect(customKeyFor('9 lakh', [])).toBe('lakh');
  });
});
