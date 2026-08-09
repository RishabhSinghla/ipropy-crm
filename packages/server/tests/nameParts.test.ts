import { describe, expect, it } from 'vitest';
import { deriveNameParts, withNameParts } from '../src/core/entity/nameParts.js';

/**
 * The lead form captures one `full_name`, but ~40 seeded template strings say
 * `{{first_name}}`. These tokens are derived rather than stored, so this suite
 * is what stops a template quietly rendering "Hi ," to a customer.
 */
describe('deriveNameParts', () => {
  it('splits a two-part name on the first space', () => {
    expect(deriveNameParts({ full_name: 'Rishabh Singhla' }))
      .toEqual({ full_name: 'Rishabh Singhla', first_name: 'Rishabh', last_name: 'Singhla' });
  });

  it('treats everything after the first token as the last name', () => {
    // "Rishabh Kumar Singhla" has no objectively correct split; the rule is
    // least-surprising rather than clever.
    expect(deriveNameParts({ full_name: 'Rishabh Kumar Singhla' }))
      .toEqual({ full_name: 'Rishabh Kumar Singhla', first_name: 'Rishabh', last_name: 'Kumar Singhla' });
  });

  it('leaves the last name empty for a single-word name rather than repeating it', () => {
    // Plenty of Indian names are one word. "Hi Priya Priya" is worse than a
    // blank last name.
    expect(deriveNameParts({ full_name: 'Priya' }))
      .toEqual({ full_name: 'Priya', first_name: 'Priya', last_name: '' });
  });

  it('prefers stored halves over splitting, for records written before the merge', () => {
    expect(deriveNameParts({ full_name: 'Asha Verma', first_name: 'Asha', last_name: 'Verma' }))
      .toEqual({ full_name: 'Asha Verma', first_name: 'Asha', last_name: 'Verma' });
  });

  it('rebuilds a full name from stored halves when full_name is missing', () => {
    expect(deriveNameParts({ first_name: 'Asha', last_name: 'Verma' }).full_name).toBe('Asha Verma');
  });

  it('falls back to the record label for modules with no name fields', () => {
    expect(deriveNameParts({ label: 'Greenfields B-904' }).first_name).toBe('Greenfields');
  });

  it('collapses extra whitespace instead of producing empty tokens', () => {
    expect(deriveNameParts({ full_name: '  Rishabh   Singhla  ' }))
      .toEqual({ full_name: 'Rishabh   Singhla', first_name: 'Rishabh', last_name: 'Singhla' });
  });

  it('returns empty parts when there is no name at all', () => {
    expect(deriveNameParts({})).toEqual({ full_name: '', first_name: '', last_name: '' });
  });
});

describe('withNameParts', () => {
  it('adds the derived tokens without dropping the rest of the scope', () => {
    const scope = withNameParts({ full_name: 'Rishabh Singhla', mobile: '9812345678' });
    expect(scope.first_name).toBe('Rishabh');
    expect(scope.mobile).toBe('9812345678');
  });

  it('does not mutate the scope it was given', () => {
    // Merge scopes are reused across several renders in one workflow run; a
    // helper that rewrites its input leaks one step's data into the next.
    const original: Record<string, unknown> = { full_name: 'Rishabh Singhla' };
    withNameParts(original);
    expect(original.first_name).toBeUndefined();
  });

  it('leaves a nameless scope untouched so an upstream fallback still applies', () => {
    const scope = withNameParts({ first_name: 'there', org_name: 'iPropy' });
    expect(scope.first_name).toBe('there');
  });
});
