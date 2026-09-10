/**
 * Which type changes are possible, and what each one costs.
 *
 * The field editor used to refuse every change the storage could not absorb —
 * "Locality is stored as multipicklist, so it can only become JSON, Address,
 * Multi Lookup, Tags" — and told the admin to build a second field instead.
 * These pin the routes that replaced that, and in particular pin which of them
 * are lossy: a conversion that silently empties four hundred records is the
 * failure the count exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { conversionPlan } from '../../src/core/metadata/convertColumn.js';

describe('conversionPlan', () => {
  it('needs no work when the SQL type is the same', () => {
    // Email and Text are both TEXT: only the validation changes.
    const plan = conversionPlan('email', 'string');
    expect(plan?.using).toBe('%s');
    expect(plan?.lossy).toBeNull();
  });

  it('turns a multi-select into a dropdown, keeping the first choice', () => {
    const plan = conversionPlan('multipicklist', 'picklist');
    expect(plan).not.toBeNull();
    // Lossy only where a record actually chose more than one.
    expect(plan!.lossy).toContain('jsonb_array_length');
    expect(plan!.note).toMatch(/more than one value keep the first/);
  });

  it('turns a dropdown into a multi-select without losing anything', () => {
    const plan = conversionPlan('picklist', 'multipicklist');
    expect(plan?.lossy).toBeNull();
  });

  it('lets any number or date become text, losslessly', () => {
    for (const from of ['integer', 'decimal', 'currency', 'date', 'boolean']) {
      const plan = conversionPlan(from, 'string');
      expect(plan, from).not.toBeNull();
      expect(plan!.lossy, from).toBeNull();
    }
  });

  it('guards every cast that can fail, and calls it lossy', () => {
    for (const to of ['integer', 'decimal', 'date', 'datetime', 'boolean']) {
      const plan = conversionPlan('string', to);
      expect(plan, to).not.toBeNull();
      // `ipy_try_*` (migration 112), never a bare `::`. A bare cast raises on
      // the first bad value and fails the whole statement, so the admin is
      // told nothing except that it did not work.
      expect(plan!.using, to).toMatch(/^ipy_try_/);
      expect(plan!.lossy, to).not.toBeNull();
    }
  });

  it('refuses a route it has no honest answer for', () => {
    // A list of choices is not a date, and no rule for turning one into the
    // other would be less surprising than saying so.
    expect(conversionPlan('multipicklist', 'date')).toBeNull();
    expect(conversionPlan('formula', 'string')).toBeNull();
  });
});
