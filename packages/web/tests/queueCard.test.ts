import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { cardArea, cardPrice, queueCardColumns, queueCardFields, unitDescription, withQueueCardColumns } from '../src/lib/queueCard';

const field = (name: string, config: Record<string, unknown> = {}): FieldMeta =>
  ({ name, columnName: name, label: name, isActive: true, displayType: 'default', config }) as unknown as FieldMeta;

// The fields production's Contacts module has (read off it, 26 September 2026).
const leads = [
  field('contact_type'), field('unit_no'), field('portion'), field('configuration'), field('category'),
  field('preferred_locations'), field('budget'), field('area_size', { unitField: 'area_size_unit' }),
  field('next_followup_at'),
];

describe('queue card', () => {
  it('finds each fact under the name this module uses', () => {
    const card = queueCardFields(leads);
    expect(card.unit?.name).toBe('unit_no');
    expect(card.price?.name).toBe('budget');
    const units = queueCardFields([field('unit_number'), field('demand'), field('portion_type')]);
    expect(units.unit?.name).toBe('unit_number');
    expect(units.price?.name).toBe('demand');
    expect(units.portion?.name).toBe('portion_type');
  });

  it('asks the list for an area\'s unit as well as the area', () => {
    expect(queueCardColumns(leads)).toEqual(expect.arrayContaining(['area_size', 'area_size_unit', 'next_followup_at']));
  });

  it('requests admin-arranged left pane fields even when the saved list view omitted them', () => {
    const columns = withQueueCardColumns(['full_name'], leads, ['category', 'preferred_locations']);
    expect(columns).toEqual(expect.arrayContaining(['full_name', 'category', 'preferred_locations']));
    expect(columns?.filter((name) => name === 'category')).toHaveLength(1);
  });

  it('skips a field that is switched off', () => {
    const off = { ...field('unit_no'), isActive: false } as FieldMeta;
    expect(queueCardFields([off, field('unit_number')]).unit?.name).toBe('unit_number');
  });

  it('writes the middle line the way the owner wrote it', () => {
    const values: Record<string, string> = {
      portion: 'Single', configuration: '4 BHK', category: 'Builder Floor', preferred_locations: 'Greenfields Colony',
    };
    const line = unitDescription(queueCardFields(leads), (f) => values[f.name] ?? '');
    // Size first, then portion, category and locality, each its own fact —
    // 26 September 2026, the owner: "Accommodation/Configuration then portion
    // then catagory then Locality i.e 3 BHK, Single, Builder Floor,
    // Greenfields Colony".
    expect(line).toBe('4 BHK, Single, Builder Floor, Greenfields Colony');
  });

  it('drops missing parts without stray commas', () => {
    const line = unitDescription(queueCardFields(leads), (f) => (f.name === 'category' ? 'Villa' : ''));
    expect(line).toBe('Villa');
  });

  it('prints price and size, or nothing', () => {
    expect(cardPrice(18500000)).toBe('₹1.85 Cr');
    expect(cardPrice(null)).toBe('');
    expect(cardPrice(0)).toBe('');
    expect(cardArea(2100, 'sqft')).toBe('2,100 sq.ft');
    expect(cardArea(null, 'sqft')).toBe('');
  });
});
