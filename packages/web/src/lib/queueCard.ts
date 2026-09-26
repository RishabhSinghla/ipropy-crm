/**
 * What the split view's queue card shows, and which fields it reads.
 *
 * **26 September 2026, the owner**, with a mock-up of the card he wanted:
 *
 *   Sobha Rawat  [BUYER]                                              ☆
 *   🏢 H. No: A-2701 • Single, 4 BHK Builder Floor, Greenfields Colony
 *   ₹1.85 Cr  2,100 sq.ft                                     [TODAY]
 *
 * Contacts and Inventories name the same facts differently — a contact's
 * `unit_no` and `budget`, a unit's `unit_number` and `demand` — so each fact
 * is a short list of field names, first one present wins. A fact the module
 * does not have simply drops out of the line.
 */
import { formatArea, formatIndianPrice, type FieldMeta } from '@ipropy/shared';
import { fieldByKey } from './fields';

const CANDIDATES = {
  type: ['contact_type'],
  unit: ['unit_no', 'unit_number'],
  portion: ['portion', 'portion_type'],
  bedrooms: ['configuration', 'bedrooms'],
  category: ['category'],
  locality: ['preferred_locations', 'locality'],
  price: ['budget', 'demand', 'asking_price'],
  area: ['area_size', 'area'],
  followUp: ['next_followup_at', 'next_follow_up'],
} as const;

export type CardFact = keyof typeof CANDIDATES;
export type CardFields = Partial<Record<CardFact, FieldMeta>>;

/** The field behind each fact on this module, skipping any switched off. */
export function queueCardFields(fields: FieldMeta[]): CardFields {
  const found: CardFields = {};
  for (const fact of Object.keys(CANDIDATES) as CardFact[]) {
    for (const name of CANDIDATES[fact]) {
      const field = fieldByKey(fields, name);
      if (field?.isActive && field.displayType !== 'hidden') {
        found[fact] = field;
        break;
      }
    }
  }
  return found;
}

/**
 * Every field the card reads, for the list request.
 *
 * A list row carries only the values the list asked for, so without these the
 * card would print blanks on any saved view whose columns leave them out. An
 * area's unit is its own field and has to be asked for too.
 */
export function queueCardColumns(fields: FieldMeta[]): string[] {
  const names: string[] = [];
  for (const field of Object.values(queueCardFields(fields))) {
    names.push(field.name);
    const unitField = field.config.unitField;
    if (typeof unitField === 'string') names.push(unitField);
  }
  return names;
}

/** A list's columns plus what the card reads; undefined means the server's defaults. */
export function withQueueCardColumns(columns: string[] | undefined, fields: FieldMeta[] | undefined): string[] | undefined {
  if (!columns || !fields) return columns;
  const extra = queueCardColumns(fields).filter((name) => !columns.includes(name));
  return extra.length ? [...columns, ...extra] : columns;
}

type Reader = (field: FieldMeta) => string;

/**
 * "Single, 4 BHK Builder Floor, Greenfields Colony" — portion, then bedrooms
 * and category as one phrase, then the locality.
 */
export function unitDescription(card: CardFields, read: Reader): string {
  const text = (field?: FieldMeta): string => (field ? read(field).trim() : '');
  const kind = [text(card.bedrooms), text(card.category)].filter(Boolean).join(' ');
  return [text(card.portion), kind, text(card.locality)].filter(Boolean).join(', ');
}

/** "₹1.85 Cr", or empty when there is no price. */
export function cardPrice(value: unknown): string {
  const amount = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(amount) || amount <= 0) return '';
  return formatIndianPrice(amount);
}

/** "2,100 sq.ft", or empty when there is no size. */
export function cardArea(value: unknown, unit: unknown): string {
  const size = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(size) || size <= 0) return '';
  return formatArea(size, typeof unit === 'string' ? unit : undefined);
}
