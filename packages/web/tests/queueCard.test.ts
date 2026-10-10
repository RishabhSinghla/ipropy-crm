import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { cardArea, cardPrice, oneOfEach, queueAge, queueCardColumns, queueCardFields, unitDescription, withQueueCardColumns } from '../src/lib/queueCard';

const field = (name: string, config: Record<string, unknown> = {}): FieldMeta =>
  ({ name, columnName: name, label: name, isActive: true, displayType: 'default', config }) as unknown as FieldMeta;

// The fields production's Contacts module has (read off it, 26 September 2026).
const leads = [
  field('contact_type'), field('unit_no'), field('portion'), field('configuration'), field('category'),
  field('preferred_locations'), field('budget'), field('area_size', { unitField: 'area_size_unit' }),
  field('next_followup_at'),
];

describe('queue card', () => {
  it('uses compact units for queue ages', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    expect(queueAge('2026-10-11T11:59:40Z', now)).toBe('20 S ago');
    expect(queueAge('2026-10-11T11:40:00Z', now)).toBe('20 M ago');
    expect(queueAge('2026-10-09T12:00:00Z', now)).toBe('2 D ago');
    expect(queueAge('bad date', now)).toBe('');
  });
  it('requests a renamed assignment field for the agent chip', () => {
    const renamed = { ...field('agent'), columnName: 'owner_id', uitype: 'owner' } as FieldMeta;
    expect(queueCardFields([renamed]).agent).toBe(renamed);
    expect(queueCardColumns([renamed])).toContain('agent');
  });
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
    expect(cardArea(2100, 'sqft')).toBe('2,100 Sq. Ft.');
    expect(cardArea(null, 'sqft')).toBe('');
  });
});

/**
 * The middle line says each fact once.
 *
 * **3 October 2026, the owner:** *"in the left record pane, we see dual House
 * No 'A-2029, A-2029', Please check duplicate and fix it."* Two fields on that
 * module hold the same unit number and both are flagged for the line.
 */
describe('the queue card line', () => {
  it('says a repeated fact once', () => {
    expect(oneOfEach(['A-2029', 'A-2029', 'Single (Non CC)', 'Builder Floor']))
      .toBe('A-2029, Single (Non CC), Builder Floor');
  });

  it('reads two spellings of one fact as one', () => {
    // "A-2029" and "a-2029 " are one fact to a person, and a person is who
    // reads this line.
    expect(oneOfEach(['A-2029', ' a-2029 ', 'Builder Floor'])).toBe('A-2029, Builder Floor');
  });

  it('keeps the first spelling, which is the order the admin arranged', () => {
    expect(oneOfEach(['Builder Floor', 'A-2029', 'BUILDER FLOOR'])).toBe('Builder Floor, A-2029');
  });

  it('drops blanks and the dash an empty field renders as', () => {
    expect(oneOfEach(['', '—', '  ', 'Neharpar'])).toBe('Neharpar');
  });

  it('answers nothing when there is nothing to say', () => {
    expect(oneOfEach([])).toBe('');
    expect(oneOfEach(['', '—'])).toBe('');
  });
});
