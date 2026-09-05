import { describe, expect, it } from 'vitest';
import { type FieldMeta, toInternational } from '@ipropy/shared';
import { validateValues } from '../src/core/metadata/values.js';

/**
 * Validation is metadata-driven on purpose: every rule below is read from a
 * field's own config, so an admin adding a field gets the same enforcement
 * without a deploy and the engine never learns what a "budget" is.
 */
function field(partial: Partial<FieldMeta> & { name: string; uitype: string }): FieldMeta {
  return {
    id: partial.name, moduleId: 'm', moduleName: 'leads', blockId: null,
    label: partial.label ?? partial.name, sequence: 0,
    isMandatory: false, isReadonly: false, isUnique: false, isCustom: false, isActive: true,
    displayType: 'default', defaultValue: null, maxLength: null, helpText: null,
    config: {}, quickCreate: false, massEditable: true, searchable: false,
    storage: 'column', columnName: partial.name, options: [],
    ...partial,
  } as FieldMeta;
}

const expectFail = (fields: FieldMeta[], values: Record<string, unknown>, merged = values): string => {
  try {
    validateValues(fields, values, merged);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected validation to fail, but it passed');
};

describe('validateValues — lengths and formats', () => {
  it('rejects text longer than the field allows', () => {
    const f = [field({ name: 'full_name', uitype: 'string', label: 'Full Name', maxLength: 10 })];
    expect(expectFail(f, { full_name: 'x'.repeat(11) })).toMatch(/cannot be longer than 10/);
  });

  it('accepts text exactly at the limit', () => {
    const f = [field({ name: 'full_name', uitype: 'string', maxLength: 10 })];
    expect(() => validateValues(f, { full_name: 'x'.repeat(10) }, {})).not.toThrow();
  });

  it('rejects a malformed email', () => {
    const f = [field({ name: 'email', uitype: 'email', label: 'Email' })];
    expect(expectFail(f, { email: 'not-an-address' })).toMatch(/does not look like an email/);
  });

  it('accepts the plus-addressing and subdomains that real people use', () => {
    const f = [field({ name: 'email', uitype: 'email' })];
    expect(() => validateValues(f, { email: 'rishabh+crm@mail.ipropy.co.in' }, {})).not.toThrow();
  });

  it('enforces an exact digit count for mobile numbers', () => {
    const f = [field({ name: 'mobile', uitype: 'phone', label: 'Mobile', config: { digits: 10 } })];
    expect(expectFail(f, { mobile: '98123' })).toMatch(/exactly 10 digits/);
    expect(() => validateValues(f, { mobile: '9812345678' }, {})).not.toThrow();
  });

  it('ignores formatting when counting digits', () => {
    const f = [field({ name: 'mobile', uitype: 'phone', config: { digits: 10 } })];
    expect(() => validateValues(f, { mobile: '98123 45678' }, {})).not.toThrow();
  });

  describe('digit count follows the selected country', () => {
    // A flat "10 digits" rule would make the country dropdown decorative and
    // lock out every NRI buyer, which is the opposite of why it was added.
    const mobile = [field({
      name: 'mobile', uitype: 'phone', label: 'Mobile',
      config: { digits: 10, digitsFrom: 'country_code', digitsMap: { '+91': 10, '+971': 9, '+65': 8 } },
    })];

    it('requires ten digits for India', () => {
      expect(() => validateValues(mobile, { mobile: '9812345678' }, { country_code: '+91', mobile: '9812345678' }))
        .not.toThrow();
      expect(expectFail(mobile, { mobile: '98123456' }, { country_code: '+91', mobile: '98123456' }))
        .toMatch(/exactly 10 digits/);
    });

    it('requires nine for the UAE and eight for Singapore', () => {
      expect(() => validateValues(mobile, { mobile: '501234567' }, { country_code: '+971', mobile: '501234567' }))
        .not.toThrow();
      expect(() => validateValues(mobile, { mobile: '91234567' }, { country_code: '+65', mobile: '91234567' }))
        .not.toThrow();
    });

    it('rejects an Indian-length number once the country says UAE', () => {
      expect(expectFail(mobile, { mobile: '9812345678' }, { country_code: '+971', mobile: '9812345678' }))
        .toMatch(/exactly 9 digits/);
    });

    it('accepts an unmapped country at a length no rule covers', () => {
      // Refusing to store a number we have no rule for is worse than storing
      // it. Nine digits would fail India's rule, so this only passes because
      // the unmapped country genuinely disables the exact-length check.
      expect(() => validateValues(mobile, { mobile: '901234567' }, { country_code: '+81', mobile: '901234567' }))
        .not.toThrow();
    });

    it('still rejects nonsense for an unmapped country', () => {
      // The generic phone sanity check (6–15 digits) is not country-specific
      // and keeps applying when the exact-length rule does not.
      expect(expectFail(mobile, { mobile: '123' }, { country_code: '+81', mobile: '123' }))
        .toMatch(/does not look like a phone number/);
    });

    it('falls back to the default count when no country is set', () => {
      expect(expectFail(mobile, { mobile: '123456' }, { mobile: '123456' })).toMatch(/exactly 10 digits/);
    });
  });

  it('requires a scheme on URLs', () => {
    const f = [field({ name: 'website', uitype: 'url', label: 'Website' })];
    expect(expectFail(f, { website: 'ipropy.com' })).toMatch(/http/);
  });
});

describe('validateValues — numeric ranges', () => {
  const budget = [
    field({ name: 'budget_min', uitype: 'currency', label: 'Budget From', config: { min: 0, notAfterField: 'budget_max' } }),
    field({ name: 'budget_max', uitype: 'currency', label: 'Budget To', config: { min: 0 } }),
  ];

  it('rejects a negative amount', () => {
    expect(expectFail(budget, { budget_max: -5 })).toMatch(/cannot be less than 0/);
  });

  it('rejects a minimum above the maximum', () => {
    expect(expectFail(budget, { budget_min: 9_000_000, budget_max: 5_000_000 }))
      .toMatch(/Budget From cannot be more than Budget To/);
  });

  it('accepts a minimum equal to the maximum', () => {
    expect(() => validateValues(budget, { budget_min: 5, budget_max: 5 }, { budget_min: 5, budget_max: 5 }))
      .not.toThrow();
  });

  it('checks a partial update against the value already stored', () => {
    // Editing only "budget from" must still be compared with the "budget to"
    // on the record — otherwise the rule is trivially bypassed by two saves.
    expect(expectFail(budget, { budget_min: 9_000_000 }, { budget_min: 9_000_000, budget_max: 5_000_000 }))
      .toMatch(/cannot be more than/);
  });

  it('skips the cross-field rule when the other side is empty', () => {
    expect(() => validateValues(budget, { budget_min: 9_000_000 }, { budget_min: 9_000_000 })).not.toThrow();
  });
});

describe('validateValues — behaviour', () => {
  it('reports every problem at once rather than one per submit', () => {
    const f = [
      field({ name: 'email', uitype: 'email', label: 'Email' }),
      field({ name: 'mobile', uitype: 'phone', label: 'Mobile', config: { digits: 10 } }),
    ];
    const message = expectFail(f, { email: 'bad', mobile: '1' });
    expect(message).toMatch(/Email/);
    expect(message).toMatch(/Mobile/);
  });

  it('ignores fields absent from the payload', () => {
    const f = [field({ name: 'email', uitype: 'email' })];
    expect(() => validateValues(f, {}, {})).not.toThrow();
  });

  it('treats an empty optional field as fine — that is validateRequired\'s job', () => {
    const f = [field({ name: 'email', uitype: 'email' })];
    expect(() => validateValues(f, { email: '' }, {})).not.toThrow();
  });

  it('does not let a malformed regex in metadata block every save', () => {
    const f = [field({ name: 'code', uitype: 'string', config: { pattern: '([unclosed' } })];
    expect(() => validateValues(f, { code: 'anything' }, {})).not.toThrow();
  });

  it('skips inactive fields', () => {
    const f = [field({ name: 'email', uitype: 'email', isActive: false })];
    expect(() => validateValues(f, { email: 'bad' }, {})).not.toThrow();
  });
});

describe('toInternational', () => {
  it('combines a country code with a national number', () => {
    expect(toInternational('+91', '9812345678')).toBe('+919812345678');
    expect(toInternational('+971', '501234567')).toBe('+971501234567');
  });

  it('does not double a code the number already carries', () => {
    // "+9191..." is how a lead becomes permanently unreachable.
    expect(toInternational('+91', '919812345678')).toBe('+919812345678');
  });

  it('trusts an explicit + on the number over the field', () => {
    expect(toInternational('+91', '+971501234567')).toBe('+971501234567');
  });

  it('falls back to the India default when no code is stored', () => {
    // Records written before the split, and modules with no country field.
    expect(toInternational(null, '9812345678')).toBe('+919812345678');
  });

  it('strips formatting', () => {
    expect(toInternational('+91', '98123-45678')).toBe('+919812345678');
  });

  it('returns null for an empty number', () => {
    expect(toInternational('+91', '')).toBeNull();
    expect(toInternational('+91', null)).toBeNull();
  });
});
