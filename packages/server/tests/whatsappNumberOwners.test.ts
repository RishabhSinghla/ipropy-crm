/**
 * A chat's number is matched against every module, not only contacts. The two
 * decisions that can be tested without a database: how numbers are normalised,
 * and which owner is shown first when several hold the same number.
 */
import { describe, expect, it } from 'vitest';
import { sortOwners, ownerKey, type NumberOwner } from '../src/integrations/whatsapp/numberOwners.js';

const owner = (module: string, rank: number, fieldRank: number, label: string) => ({
  recordId: `${module}-${label}`, module, moduleLabel: module, label, fieldLabel: 'Mobile', rank, fieldRank,
});

describe('the key a chat number is compared on', () => {
  it('is the last ten digits whatever the shape', () => {
    for (const shape of ['9811050512', '+91 9811050512', '09811050512', '91-98110 50512', '919811050512@s.whatsapp.net', '0091 98110-50512']) {
      expect(ownerKey(shape)).toBe('9811050512');
    }
  });
  it('has no key for something too short', () => {
    expect(ownerKey('12345')).toBeNull();
    expect(ownerKey(null)).toBeNull();
  });
});

describe('who is shown first when several records hold one number', () => {
  it('puts contacts before inventory owners, then keeps module order', () => {
    const sorted: NumberOwner[] = sortOwners([
      owner('properties', 1, 0, 'Mahesh Gupta'),
      owner('projects', 3, 0, 'DLF Arbour'),
      owner('leads', 0, 1, 'Mahesh (alt)'),
      owner('builder_floors', 2, 0, 'House 12'),
    ]);
    expect(sorted.map((o) => o.module)).toEqual(['leads', 'properties', 'builder_floors', 'projects']);
  });
  it('shows the main number before an alternate one in the same module', () => {
    const sorted = sortOwners([owner('leads', 0, 1, 'B'), owner('leads', 0, 0, 'A')]);
    expect(sorted.map((o) => o.label)).toEqual(['A', 'B']);
  });
  it('leaves the ranking fields out of what the screen gets', () => {
    expect(Object.keys(sortOwners([owner('leads', 0, 0, 'A')])[0]!)).not.toContain('rank');
  });
});
