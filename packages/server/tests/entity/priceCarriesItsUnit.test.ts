/**
 * A price on screen must say which price it is.
 *
 * "₹1.5 Cr" and "₹1.5 Cr per Sq. Ft." are not the same offer, and on a 280
 * sq.yd. builder floor they are four orders of magnitude apart. The record page
 * showed the first where it meant the second, and did it in two separate ways.
 *
 * **The label came from a hardcoded ladder.** `total`, else `sqft`, else assume
 * `sqyd`. The Budget / Demand unit master an admin actually edits offers four
 * options including "Per Sq. Mtr.", so a square-metre price printed as
 * "per Sq.yd." — confidently, and wrong by a factor of nine.
 *
 * **An unstored unit printed nothing.** The editor's dropdown falls back to the
 * unit field's own default and shows "Lumpsum"; the read-only value fell back
 * to no qualifier at all. So Market Price read as a bare amount on every one of
 * the 25,545 properties that predate the field, and the screen disagreed with
 * itself depending on whether you happened to be editing.
 *
 * Asking Price hid both bugs by accident: a migration had filled its unit on
 * almost every row, and the value it filled was the one the ladder spelled
 * correctly.
 */
import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { priceWithUnit } from '../../src/core/entity/recordService.js';

/** What `registry.syncUnitMasters` puts on a Budget / Demand field at runtime. */
const BUDGET_DEMAND = [
  { value: 'total', label: 'Lumpsum' },
  { value: 'sqft', label: 'Per Sq. Ft.' },
  { value: 'sqyd', label: 'Per Sq. Yd.' },
  { value: 'sqm', label: 'Per Sq. Mtr.' },
];

const field = (config: Record<string, unknown>, defaultValue: unknown = null): FieldMeta => ({
  config, defaultValue,
} as unknown as FieldMeta);

const price = field({ unitField: 'market_price_unit', unitOptions: BUDGET_DEMAND });
/** The companion the admin route creates, defaulted to `total` (budget_demand). */
const unitField = field({ unitOptions: BUDGET_DEMAND }, 'total');

describe('a price and its qualifier', () => {
  it('names the unit an admin chose, not one compiled in', () => {
    expect(priceWithUnit(15_000_000, price, unitField, 'sqft')).toBe('₹1.5 Cr Per Sq. Ft.');
    expect(priceWithUnit(15_000_000, price, unitField, 'sqyd')).toBe('₹1.5 Cr Per Sq. Yd.');
  });

  it('spells a unit the old ladder could not reach', () => {
    // The whole point. `sqm` fell off the end of `total → sqft → assume sqyd`
    // and printed "per Sq.yd." — a different number, stated as fact.
    expect(priceWithUnit(15_000_000, price, unitField, 'sqm')).toBe('₹1.5 Cr Per Sq. Mtr.');
  });

  it('falls back to the same default the editor shows', () => {
    // No stored unit: the dropdown says "Lumpsum", so the saved value must too.
    expect(priceWithUnit(18_500_000, price, unitField, null)).toBe('₹1.85 Cr Lumpsum');
    expect(priceWithUnit(18_500_000, price, unitField, undefined)).toBe('₹1.85 Cr Lumpsum');
  });

  it('says only the amount when there is genuinely no unit to name', () => {
    // A currency field with no companion and no options is a plain amount —
    // inventing a qualifier there would be worse than omitting one.
    expect(priceWithUnit(15_000_000, field({ unitField: 'x' }), null, null)).toBe('₹1.5 Cr');
  });

  it('never invents a label for a unit the master does not offer', () => {
    // A value left behind by a renamed or deleted option must not be dressed
    // up as one of the options that still exist.
    expect(priceWithUnit(15_000_000, price, unitField, 'furlong')).toBe('₹1.5 Cr');
  });

  it('reads the options off the companion when the amount field lacks them', () => {
    const bare = field({ unitField: 'market_price_unit' });
    expect(priceWithUnit(15_000_000, bare, unitField, 'sqft')).toBe('₹1.5 Cr Per Sq. Ft.');
  });
});
