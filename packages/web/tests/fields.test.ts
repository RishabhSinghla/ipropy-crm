import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { assignmentField, byLabel, fieldByKey } from '../src/lib/fields';

/**
 * Finding a field without hard-coding its name.
 *
 * This business renames fields constantly, and a rename moves `ipy_field.name`
 * while leaving `column_name` alone — so anything that stores a *key* (a saved
 * view's filter, a widget's config, a workflow condition) may be holding either
 * one. `fieldByKey` is what lets a screen resolve both.
 */
function field(over: Partial<FieldMeta>): FieldMeta {
  return {
    id: over.name ?? 'f', name: 'f', label: 'F', uitype: 'string',
    isActive: true, isMandatory: false, isCustom: false, displayType: 'default',
    config: {}, ...over,
  } as FieldMeta;
}

describe('fieldByKey', () => {
  const fields = [
    field({ name: 'assigned_to', label: 'Assigned To', uitype: 'owner', columnName: 'owner_id' }),
    field({ name: 'full_name', label: 'Full Name', columnName: 'full_name' }),
  ];

  it('finds a field by its current name', () => {
    expect(fieldByKey(fields, 'assigned_to')?.label).toBe('Assigned To');
  });

  /*
    The case that shipped broken for an afternoon.

    The built-in "My Leads" view stores its condition as `owner_id` — the
    column. Once the filter builder stopped offering a system pseudo-field for
    a column the module already had a real field for, resolving by name alone
    found nothing and fell through to the first field in the list, so opening
    that view showed "Alternate Phone" where it should say Assigned To — and
    saving would have written that back.
  */
  it('finds it by column name when the field has since been renamed', () => {
    expect(fieldByKey(fields, 'owner_id')?.name).toBe('assigned_to');
  });

  it('answers undefined for a key belonging to no field at all', () => {
    // A field somebody deleted. The caller decides what to do; guessing here
    // is how a stale key silently becomes a different field.
    expect(fieldByKey(fields, 'company')).toBeUndefined();
  });
});

describe('assignmentField', () => {
  it('finds the assignee by uitype, whatever it is called', () => {
    const found = assignmentField([
      field({ name: 'full_name', label: 'Full Name' }),
      field({ name: 'relationship_manager', label: 'RM', uitype: 'owner' }),
    ]);
    expect(found?.name).toBe('relationship_manager');
  });

  it('falls back to the owner column when no field declares the uitype', () => {
    const found = assignmentField([field({ name: 'legacy', label: 'Legacy', columnName: 'owner_id' })]);
    expect(found?.name).toBe('legacy');
  });
});

describe('byLabel', () => {
  it('sorts by label and leaves the caller’s array alone', () => {
    const original = [field({ label: 'Zebra' }), field({ label: 'Apple' })];
    const sorted = byLabel(original);
    expect(sorted.map((f) => f.label)).toEqual(['Apple', 'Zebra']);
    // These arrays come out of React Query's cache; sorting one in place
    // mutates state every other component is reading.
    expect(original.map((f) => f.label)).toEqual(['Zebra', 'Apple']);
  });
});
