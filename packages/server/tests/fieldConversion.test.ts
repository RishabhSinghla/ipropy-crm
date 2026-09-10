import { describe, expect, it } from 'vitest';
import { convertFieldValue } from '../src/core/metadata/fieldConversion.js';

describe('field type conversion', () => {
  it('converts compatible values without changing the original field identity', () => {
    expect(convertFieldValue('1,60,00,000', { targetType: 'currency', invalidStrategy: 'blank' })).toEqual({ ok: true, value: 16000000 });
    expect(convertFieldValue('yes', { targetType: 'boolean', invalidStrategy: 'blank' })).toEqual({ ok: true, value: true });
  });

  it('flags incompatible values for the chosen safe strategy', () => {
    expect(convertFieldValue('Greenfields', { targetType: 'date', invalidStrategy: 'blank' })).toEqual({ ok: false });
  });
});
