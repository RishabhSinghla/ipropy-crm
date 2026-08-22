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
