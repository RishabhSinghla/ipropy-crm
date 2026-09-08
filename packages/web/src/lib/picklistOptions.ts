import type { PicklistOption } from '@ipropy/shared';

/**
 * A stored value the option list no longer contains still has to render.
 *
 * Records carry picklist values from before the list existed in this shape —
 * a locality typed before the City → Locality map covered that city, a value
 * an admin later deleted, one written through import. A form whose <select>
 * only offers today's options renders such a value as blank, and the next
 * save writes the blank over the real one (a property's locality vanished
 * exactly this way). The phone control learned the rule first — a stored
 * country code whose option was deleted still has to show — and this is the
 * same rule for every picklist, shared by the edit form and the inline
 * popover.
 *
 * The stored value is appended, labelled as itself, the way list views and
 * badges already render it. Saving an untouched form then sends nothing (the
 * value equals what the record already has), so editing some other field can
 * no longer destroy what this one could not display.
 */
export function optionsWithValue(options: PicklistOption[] | undefined, value: unknown): PicklistOption[] {
  const all = options ?? [];
  const current = value === null || value === undefined ? '' : String(value);
  if (!current || all.some((o) => o.value === current)) return all;
  return [
    ...all,
    { value: current, label: current, color: null, sequence: all.length, isActive: true },
  ];
}