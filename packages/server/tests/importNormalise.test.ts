import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { normaliseImportRow } from '../src/core/import/normalise.js';

function field(name: string, uitype: FieldMeta['uitype']): FieldMeta {
  return {
    id: name, internalId: `fld_${name}`, moduleId: 'module', moduleName: 'properties', blockId: null,
    name, label: name, uitype, storage: 'json', columnName: name, sequence: 1,
    isMandatory: false, isReadonly: false, isUnique: false, isCustom: true, isActive: true,
    displayType: 'default', defaultValue: null, maxLength: null, helpText: null, config: {},
    quickCreate: true, massEditable: true, searchable: true,
  };
}

describe('normaliseImportRow', () => {
  it('uses confirmed date order instead of silently swapping day and month', () => {
    const values = normaliseImportRow({ Possession: '04/03/2026' }, { Possession: 'possession' }, [field('possession', 'date')], { dateFormat: 'dd/mm/yyyy' });
    expect(values.possession).toBe('2026-03-04');
  });

  it('keeps an impossible date for validation instead of rolling it into another month', () => {
    const values = normaliseImportRow({ Possession: '31/02/2026' }, { Possession: 'possession' }, [field('possession', 'date')], { dateFormat: 'dd/mm/yyyy' });
    expect(values.possession).toBe('31/02/2026');
  });

  it('maps individual multi-picklist values and honours a custom separator', () => {
    const values = normaliseImportRow({ Amenities: 'Lift~Power backup' }, { Amenities: 'amenities' }, [field('amenities', 'multipicklist')], {
      multiValueSeparator: '~', valueMappings: { amenities: { 'Power backup': 'Power Backup' } },
    });
    expect(values.amenities).toEqual(['Lift', 'Power Backup']);
  });

  it('adds +91 only when the importer was explicitly asked to do so', () => {
    const fields = [field('mobile', 'phone')];
    expect(normaliseImportRow({ Mobile: '098100 12345' }, { Mobile: 'mobile' }, fields).mobile).toBe('098100 12345');
    expect(normaliseImportRow({ Mobile: '098100 12345' }, { Mobile: 'mobile' }, fields, { normaliseIndianPhones: true }).mobile).toBe('+919810012345');
  });
});
