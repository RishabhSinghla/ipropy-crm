import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { coerceValue, stripUnstorable } from '../src/core/metadata/values.js';

/**
 * One NUL byte used to take down the whole request.
 *
 * Postgres refuses `0x00` in a text column, so the driver failed the statement
 * with `invalid byte sequence for encoding "UTF8": 0x00` and the API answered
 * 500 — an unhandled crash caused by a character nobody can see. It reaches a
 * CRM more often than it sounds: text copied out of a PDF, a CSV exported from
 * an older system, a UTF-16 file read as UTF-8.
 */
const NUL = '\u0000';

function field(partial: Partial<FieldMeta> & { name: string; uitype: string }): FieldMeta {
  return {
    id: partial.name, label: partial.name, isRequired: false, isReadonly: false,
    isUnique: false, storage: 'column', displayType: 'default', sequence: 1,
    ...partial,
  } as FieldMeta;
}

describe('stripUnstorable', () => {
  it('removes the byte Postgres refuses', () => {
    expect(stripUnstorable(`Bob${NUL} Evil`)).toBe('Bob Evil');
    expect(stripUnstorable(NUL)).toBe('');
  });

  it('removes the other invisible C0 controls', () => {
    expect(stripUnstorable('abcd')).toBe('abcd');
  });

  it('keeps the whitespace a textarea legitimately contains', () => {
    // Stripping these would silently reformat every multi-line note.
    expect(stripUnstorable('line one\nline two\r\n\tindented')).toBe('line one\nline two\r\n\tindented');
  });

  it('leaves ordinary text — including emoji and Devanagari — alone', () => {
    expect(stripUnstorable('Sector 85, फरीदाबाद 🏠')).toBe('Sector 85, फरीदाबाद 🏠');
  });
});

describe('coerceValue strips unstorable characters for every uitype', () => {
  it('cleans a plain string rather than throwing', () => {
    expect(coerceValue(field({ name: 'full_name', uitype: 'string' }), `Bob${NUL} Evil`)).toBe('Bob Evil');
  });

  it('cleans a textarea while keeping its newlines', () => {
    expect(coerceValue(field({ name: 'notes', uitype: 'textarea' }), `a${NUL}b\nc`)).toBe('ab\nc');
  });

  it('cleans an email before the format check, so a good address still passes', () => {
    expect(coerceValue(field({ name: 'email', uitype: 'email' }), `a${NUL}b@c.com`)).toBe('ab@c.com');
  });

  it('treats a value made only of control characters as empty', () => {
    // Empty string rather than null: the text columns are NOT NULL DEFAULT ''
    // (see TEXT_TYPES), so '' is the empty this codebase stores. What matters
    // is that nothing reaches the driver that Postgres would refuse.
    expect(coerceValue(field({ name: 'full_name', uitype: 'string' }), NUL + NUL)).toBe('');
    // A uitype outside that set has no such column default and goes to null.
    expect(coerceValue(field({ name: 'email', uitype: 'email' }), NUL)).toBeNull();
  });

  it('still enforces maxLength on what survives the strip', () => {
    const f = field({ name: 'full_name', uitype: 'string', maxLength: 5 });
    expect(() => coerceValue(f, `abcdef${NUL}`)).toThrow(/at most 5/);
    expect(coerceValue(f, `abc${NUL}`)).toBe('abc');
  });
});
