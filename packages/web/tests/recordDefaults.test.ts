import { describe, expect, it } from 'vitest';
import type { FieldMeta, ModuleMeta } from '@ipropy/shared';
import { startingValues } from '../src/lib/recordDefaults';

/**
 * What a create form opens with.
 *
 * The server has always applied a field's default on save, so this looked like
 * cosmetics and was not: Lifecycle Stage and Pipeline Status are both mandatory,
 * so a form that did not fill them in refused to submit until somebody chose the
 * answer the CRM already knew. The star in Admin → Dropdowns did nothing anybody
 * could see.
 */
function field(over: Partial<FieldMeta>): FieldMeta {
  return {
    id: over.name ?? 'f', name: 'f', label: 'F', uitype: 'string',
    isActive: true, isMandatory: false, isCustom: false, displayType: 'default',
    config: {}, ...over,
  } as FieldMeta;
}

const module = (fields: FieldMeta[]): ModuleMeta => ({ fields } as ModuleMeta);

describe('startingValues', () => {
  it('takes the option starred as the default in the dropdown editor', () => {
    const values = startingValues(module([
      field({
        name: 'lifecycle_stage', uitype: 'picklist',
        options: [
          { value: 'Lead', label: 'Lead', isDefault: true },
          { value: 'Prospect', label: 'Prospect' },
        ],
      }),
    ]));
    expect(values.lifecycle_stage).toBe('Lead');
  });

  it("prefers the field's own default over the dropdown's", () => {
    const values = startingValues(module([
      field({
        name: 'status', uitype: 'picklist', defaultValue: 'Contacted',
        options: [{ value: 'New', label: 'New', isDefault: true }],
      }),
    ]));
    expect(values.status).toBe('Contacted');
  });

  it('leaves a field with no default alone rather than writing an empty value', () => {
    const values = startingValues(module([
      field({ name: 'company' }),
      field({ name: 'rating', uitype: 'picklist', options: [{ value: 'Hot', label: 'Hot' }] }),
    ]));
    expect(Object.keys(values)).toHaveLength(0);
  });

  it('wraps a multi-select default in a list, which is what the API expects', () => {
    const values = startingValues(module([
      field({
        name: 'configuration', uitype: 'multipicklist',
        options: [{ value: '2 BHK', label: '2 BHK', isDefault: true }],
      }),
    ]));
    expect(values.configuration).toEqual(['2 BHK']);
  });

  it('ignores a field nobody can fill in on the way in', () => {
    const values = startingValues(module([
      field({ name: 'hidden_one', displayType: 'detail_only', defaultValue: 'x' }),
      field({ name: 'gone', isActive: false, defaultValue: 'x' }),
    ]));
    expect(Object.keys(values)).toHaveLength(0);
  });
});

/**
 * The assignee, found by what the field *is* rather than what it is called.
 *
 * Three create screens used to pass `{ owner_id: <current user> }` as the
 * form's initial values, and it landed nowhere: `owner_id` is the *column*,
 * and the field on this business's modules is named `assigned_to`. The form
 * looked up a field by that key, found none, and every new lead and every new
 * unit opened saying "Unassigned" — while the server, which canonicalises the
 * rename, quietly assigned it to the creator anyway. So the screen disagreed
 * with the record it was about to write.
 *
 * Pinned here because this is the fourth time a rename has broken name-keyed
 * code in this repo, and because the symptom is cosmetic enough to survive a
 * long time: nothing throws, nothing 500s, the record is even owned correctly.
 */
describe('startingValues — who the record is assigned to', () => {
  it('fills the assignment field under whatever name it currently has', () => {
    const values = startingValues(
      module([field({ name: 'assigned_to', label: 'Assigned To', uitype: 'owner', columnName: 'owner_id' })]),
      'user-1',
    );
    expect(values.assigned_to).toBe('user-1');
    // And not under the column name, which is what the form was keying on.
    expect(values.owner_id).toBeUndefined();
  });

  it('finds it by uitype even when the name has nothing to do with owning', () => {
    const values = startingValues(
      module([field({ name: 'relationship_manager', label: 'RM', uitype: 'owner' })]),
      'user-1',
    );
    expect(values.relationship_manager).toBe('user-1');
  });

  it('leaves it alone when nobody is signed in yet', () => {
    // The bootstrap request has not come back on a hard reload. Writing
    // `undefined` here would look like a chosen value to the effect that fills
    // it in once the user lands.
    const values = startingValues(
      module([field({ name: 'assigned_to', uitype: 'owner' })]),
    );
    expect('assigned_to' in values).toBe(false);
  });

  it('does nothing on a module with no assignment field', () => {
    const values = startingValues(module([field({ name: 'full_name' })]), 'user-1');
    expect(values).toEqual({});
  });
});
