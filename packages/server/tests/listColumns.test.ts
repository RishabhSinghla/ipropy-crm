/**
 * The one column order, read defensively.
 *
 * This setting decides what every table in the CRM shows, for everybody, so a
 * malformed row must fall back to the shipped defaults rather than to an empty
 * arrangement. An empty array is a decision — "show no columns" — and a table
 * with no columns is not something a bad row should be able to cause.
 */
import { describe, expect, it } from 'vitest';
import { readColumns } from '../src/core/settings/ui.js';

describe('the table view setting', () => {
  it('reads a module to its columns, in order', () => {
    expect(readColumns({ leads: ['full_name', 'mobile'] }))
      .toEqual({ leads: ['full_name', 'mobile'] });
  });

  it('keeps each module separate', () => {
    const out = readColumns({ leads: ['full_name'], properties: ['unit_number'] });
    expect(Object.keys(out ?? {})).toEqual(['leads', 'properties']);
  });

  it('is null for anything that is not an object of arrays', () => {
    expect(readColumns(null)).toBeNull();
    expect(readColumns('full_name')).toBeNull();
    expect(readColumns(['full_name'])).toBeNull();
    expect(readColumns({ leads: 'full_name' })).toBeNull();
  });

  it('drops empties rather than showing a table with no columns', () => {
    expect(readColumns({ leads: [] })).toBeNull();
    expect(readColumns({ leads: ['', '  '] })).toBeNull();
  });

  it('ignores entries that are not strings, and keeps the rest', () => {
    expect(readColumns({ leads: ['full_name', 7, null, 'mobile'] }))
      .toEqual({ leads: ['full_name', 'mobile'] });
  });
});
