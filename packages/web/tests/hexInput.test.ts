/**
 * Typing a colour code into the Dropdowns editor.
 *
 * The ten preset swatches became one picker and a text box on 29 September
 * 2026, and a text box means somebody types into it — including a paste with
 * a `#` already on it, a stray space, or three characters and a pause.
 */
import { describe, expect, it } from 'vitest';
import { isCompleteHex, tidyHexInput } from '../src/lib/color';

describe('tidying a colour code as it is typed', () => {
  it('keeps exactly one hash, however many were pasted', () => {
    expect(tidyHexInput('#64748b')).toBe('#64748B');
    expect(tidyHexInput('64748b')).toBe('#64748B');
    expect(tidyHexInput('##64748b')).toBe('#64748B');
  });

  it('drops anything that is not a hex digit', () => {
    expect(tidyHexInput('64 74 8b')).toBe('#64748B');
    expect(tidyHexInput('64-74-8b')).toBe('#64748B');
    expect(tidyHexInput('zzz')).toBe('#');
  });

  it('makes nonsense of a pasted rgb() string, and that is the honest answer', () => {
    // `b`, then every digit: b100116139, capped at six. It is wrong, and the
    // swatch beside the box shows it as wrong the instant it is pasted — which
    // is cheaper than a parser for a format this box does not accept.
    expect(tidyHexInput('rgb(100,116,139)')).toBe('#B10011');
  });

  it('never grows past six digits', () => {
    expect(tidyHexInput('64748bff00')).toBe('#64748B');
  });

  it('leaves a half-typed code alone rather than guessing', () => {
    expect(tidyHexInput('64')).toBe('#64');
  });
});

describe('whether a code can be painted with', () => {
  it('accepts the two lengths CSS does', () => {
    expect(isCompleteHex('#64748B')).toBe(true);
    expect(isCompleteHex('#abc')).toBe(true);
  });

  it('refuses a half-typed one without calling it an error', () => {
    expect(isCompleteHex('#64')).toBe(false);
    expect(isCompleteHex('#')).toBe(false);
    expect(isCompleteHex('')).toBe(false);
    expect(isCompleteHex(null)).toBe(false);
    expect(isCompleteHex(undefined)).toBe(false);
  });

  it('refuses something that only looks like one', () => {
    expect(isCompleteHex('64748B')).toBe(false);
    expect(isCompleteHex('#64748BB')).toBe(false);
  });
});
