import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { assignmentField, byLabel, fieldByKey, pipelineFieldOf, subtitleFieldsOf } from '../src/lib/fields';

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


/**
 * Production's own drift, pinned.
 *
 * `ipy_module.pipeline_field` on leads reads `status`, and the field has been
 * called `lead_status` since somebody renamed it — the column never moved.
 * Matching on the name alone returned undefined, which is not an error: the
 * kanban grouped by nothing and the stage breakdown did not render, silently,
 * on the module that carries 22,983 records.
 */
describe('pipelineFieldOf', () => {
  const leads = {
    pipelineField: 'status',
    fields: [
      field({ name: 'lead_status', label: 'Lead Status', uitype: 'picklist', columnName: 'status' }),
      field({ name: 'full_name', label: 'Full Name', columnName: 'full_name' }),
    ],
  };

  it('finds the field through a rename, by its column', () => {
    expect(pipelineFieldOf(leads)?.name).toBe('lead_status');
  });

  it('still prefers a field that answers to the stored name', () => {
    const properties = {
      pipelineField: 'status',
      fields: [field({ name: 'status', label: 'Status', uitype: 'picklist', columnName: 'status' })],
    };
    expect(pipelineFieldOf(properties)?.name).toBe('status');
  });

  it('is undefined when the module has no pipeline at all', () => {
    expect(pipelineFieldOf({ pipelineField: null, fields: leads.fields })).toBeUndefined();
  });

  it('is undefined when the field it names is gone entirely', () => {
    expect(pipelineFieldOf({ pipelineField: 'stage', fields: leads.fields })).toBeUndefined();
  });
});


/**
 * The line under a name reads the same way round on every module.
 *
 * Leads and Inventory both carry Contact Type and Unit Number, and their field
 * sequences put them in opposite orders — so the same two facts appeared as
 * "Builder — B-118" on one screen and "B-118 — Builder" on the other.
 */
describe('subtitleFieldsOf', () => {
  const contactType = (seq: number, order: unknown) =>
    field({ name: 'contact_type', label: 'Contact Type', sequence: seq, config: { listSubtitle: order } });
  const unitNumber = (seq: number, order: unknown) =>
    field({ name: 'unit_no', label: 'Unit Number', sequence: seq, config: { listSubtitle: order } });

  it('puts them in the same order however the module sequences them', () => {
    const leads = subtitleFieldsOf([contactType(3, 1), unitNumber(9, 2)]);
    const inventory = subtitleFieldsOf([unitNumber(2, 2), contactType(8, 1)]);
    expect(leads.map((f) => f.name)).toEqual(['contact_type', 'unit_no']);
    expect(inventory.map((f) => f.name)).toEqual(['contact_type', 'unit_no']);
  });

  it('still includes a field left at the old `true`, first', () => {
    const out = subtitleFieldsOf([unitNumber(1, 2), contactType(2, true)]);
    expect(out.map((f) => f.name)).toEqual(['contact_type', 'unit_no']);
  });

  it('falls back to field order when two carry the same position', () => {
    const out = subtitleFieldsOf([unitNumber(9, true), contactType(2, true)]);
    expect(out.map((f) => f.name)).toEqual(['contact_type', 'unit_no']);
  });

  it('leaves out anything not flagged, hidden or switched off', () => {
    const out = subtitleFieldsOf([
      contactType(1, 1),
      field({ name: 'plain', sequence: 2, config: {} }),
      field({ name: 'hidden', sequence: 3, displayType: 'hidden', config: { listSubtitle: 2 } }),
      field({ name: 'off', sequence: 4, isActive: false, config: { listSubtitle: 3 } }),
    ]);
    expect(out.map((f) => f.name)).toEqual(['contact_type']);
  });
});
