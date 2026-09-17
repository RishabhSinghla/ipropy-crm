/**
 * How full a record is, as a number a rep can act on.
 *
 * Three ways of getting this wrong, all pinned here. Counting a formula or an
 * AI score makes the percentage unreachable — nobody can type into them, so a
 * record sits short of 100 for ever with nothing to do about it. Treating `0`
 * or `false` as blank marks a finished record incomplete. And an empty list is
 * a blank, because this codebase stores "nothing chosen" as `[]` rather than
 * null.
 */
import { describe, expect, it } from 'vitest';
import { recordStrength, isAnswered, type FieldMeta, type UIType } from '@ipropy/shared';

function field(name: string, uitype: UIType = 'string', over: Partial<FieldMeta> = {}): FieldMeta {
  return {
    id: name, internalId: `fld_${name}`, moduleId: 'm', moduleName: 'leads', blockId: null,
    name, label: name, uitype, storage: 'column', columnName: name, sequence: 0,
    isMandatory: false, isReadonly: false, isUnique: false, isCustom: false, isActive: true,
    displayType: 'default', defaultValue: null, maxLength: null, helpText: null,
    config: {}, quickCreate: false, massEditable: true, searchable: true,
    ...over,
  } as FieldMeta;
}

describe('a record"s strength', () => {
  it('is the share of answerable fields that carry an answer', () => {
    const fields = [field('full_name'), field('mobile', 'phone'), field('email', 'email'), field('locality')];
    const s = recordStrength(fields, { full_name: 'Asha', mobile: '9876543210' });
    expect(s.filled).toBe(2);
    expect(s.total).toBe(4);
    expect(s.percent).toBe(50);
  });

  it('leaves out what nobody can type into', () => {
    const fields = [
      field('full_name'),
      field('ai_score', 'score'),
      field('total_value', 'rollup'),
      field('reference', 'autonumber'),
      field('margin', 'formula'),
    ];
    const s = recordStrength(fields, { full_name: 'Asha' });
    expect(s.total).toBe(1);
    expect(s.percent).toBe(100);
  });

  it('leaves out read-only and hidden fields for the same reason', () => {
    const fields = [
      field('full_name'),
      field('locked', 'string', { isReadonly: true }),
      field('bookkeeping', 'string', { displayType: 'hidden' }),
    ];
    expect(recordStrength(fields, { full_name: 'Asha' }).percent).toBe(100);
  });

  it('counts zero and false as answers, and an empty list as a blank', () => {
    const fields = [field('budget', 'currency'), field('is_nri', 'boolean'), field('configuration', 'multipicklist')];
    const s = recordStrength(fields, { budget: 0, is_nri: false, configuration: [] });
    expect(s.filled).toBe(2);
    expect(s.missing.map((m) => m.name)).toEqual(['configuration']);
  });

  it('counts whitespace as a blank', () => {
    expect(isAnswered('   ')).toBe(false);
    expect(isAnswered('Asha')).toBe(true);
  });

  it('names what is missing, mandatory first', () => {
    const fields = [
      field('email', 'email'),
      field('mobile', 'phone', { isMandatory: true }),
      field('locality'),
    ];
    const s = recordStrength(fields, {});
    expect(s.missing.map((m) => m.name)).toEqual(['mobile', 'email', 'locality']);
  });

  it('is 100 when there is nothing to fill in, not a division by zero', () => {
    expect(recordStrength([], {}).percent).toBe(100);
  });
});
