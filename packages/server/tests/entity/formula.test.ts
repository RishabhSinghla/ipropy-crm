/**
 * Unit tests for core/entity/formula.ts — the safe, admin-authored formula
 * evaluator. Every supported grammar feature plus the real-estate helpers.
 */
import { describe, expect, it } from 'vitest';
import { evaluateFormula, FORMULA_FUNCTIONS, validateFormula } from '../../src/core/entity/formula.js';

function evalF(expr: string, scope: Record<string, unknown> = {}) {
  return evaluateFormula(expr, scope);
}

describe('arithmetic', () => {
  it('respects operator precedence', () => {
    expect(evalF('2 + 3 * 4')).toBe(14);
    expect(evalF('(2 + 3) * 4')).toBe(20);
    expect(evalF('10 - 2 - 3')).toBe(5);
  });

  it('handles unary minus and NOT', () => {
    expect(evalF('-5 + 2')).toBe(-3);
    expect(evalF('-(3 * 2)')).toBe(-6);
    expect(evalF('NOT 1')).toBe(false);
    expect(evalF('NOT 0')).toBe(true);
  });

  it('divides and mods with guard against zero', () => {
    expect(evalF('10 / 4')).toBe(2.5);
    expect(evalF('10 / 0')).toBe(0);
    expect(evalF('10 % 3')).toBe(1);
    expect(evalF('10 % 0')).toBe(0);
  });
});

describe('field references and strings', () => {
  it('resolves {field} from the record scope', () => {
    expect(evalF('{price} * 0.05', { price: 2_000_000 })).toBe(100_000);
  });

  it('unknown fields resolve to null without throwing', () => {
    expect(evalF('{missing} + 1')).toBe(1);
    expect(evalF('{missing}')).toBe(null);
  });

  it('concatenates strings with +', () => {
    expect(evalF("'Hello ' + {name}", { name: 'Rahul' })).toBe('Hello Rahul');
    expect(evalF("'a' + 'b' + 'c'")).toBe('abc');
  });
});

describe('comparisons and logic', () => {
  it('compares numbers numerically', () => {
    expect(evalF('{score} > 70', { score: 85 })).toBe(true);
    expect(evalF('{score} >= 70', { score: 70 })).toBe(true);
    expect(evalF('{score} < 70', { score: 70 })).toBe(false);
  });

  it('compares strings', () => {
    expect(evalF("{status} == 'Closed-Won'", { status: 'Closed-Won' })).toBe(true);
    expect(evalF("{status} = 'Lost'", { status: 'Closed-Won' })).toBe(false);
    expect(evalF("{status} != 'Lost'", { status: 'Closed-Won' })).toBe(true);
  });

  it('AND / OR short-circuit through truthiness', () => {
    expect(evalF('{a} > 5 AND {b} == 1', { a: 10, b: 1 })).toBe(true);
    expect(evalF('{a} > 5 OR {b} == 1', { a: 1, b: 1 })).toBe(true);
    expect(evalF('{a} > 5 OR {b} == 1', { a: 1, b: 2 })).toBe(false);
  });

  it('truthiness follows the documented rules (0 and "false" are falsy)', () => {
    expect(evalF('{x} AND TRUE', { x: 0 })).toBe(false);
    expect(evalF('{x} AND TRUE', { x: 'false' })).toBe(false);
    expect(evalF('{x} AND TRUE', { x: '' })).toBe(false);
    expect(evalF('{x} AND TRUE', { x: 'any text' })).toBe(true);
  });
});

describe('functions', () => {
  it('IF(cond, a, b)', () => {
    expect(evalF('IF({score} > 70, "Hot", "Cold")', { score: 90 })).toBe('Hot');
    expect(evalF('IF({score} > 70, "Hot", "Cold")', { score: 10 })).toBe('Cold');
    expect(evalF('IF(1, 5, 6)')).toBe(5);
  });

  it('ROUND / FLOOR / CEIL / ABS / MIN / MAX / SUM', () => {
    expect(evalF('ROUND(3.14159, 2)')).toBe(3.14);
    expect(evalF('FLOOR(3.9)')).toBe(3);
    expect(evalF('CEIL(3.1)')).toBe(4);
    expect(evalF('ABS(-4)')).toBe(4);
    expect(evalF('MIN(3, 1, 2)')).toBe(1);
    expect(evalF('MAX(3, 1, 2)')).toBe(3);
    expect(evalF('SUM(1, 2, 3)')).toBe(6);
  });

  it('string functions', () => {
    expect(evalF("CONCAT('a', 'b', 'c')")).toBe('abc');
    expect(evalF("UPPER('pune')")).toBe('PUNE');
    expect(evalF("LOWER('PUNE')")).toBe('pune');
    expect(evalF("TRIM('  x  ')")).toBe('x');
    expect(evalF("LEN('hello')")).toBe(5);
    expect(evalF("LEFT('hello', 2)")).toBe('he');
    expect(evalF("RIGHT('hello', 2)")).toBe('lo');
  });

  it('COALESCE / ISEMPTY', () => {
    expect(evalF("COALESCE({a}, {b}, 'fallback')", {})).toBe('fallback');
    expect(evalF('COALESCE(1, 2)')).toBe(1);
    expect(evalF("ISEMPTY('')")).toBe(true);
    expect(evalF("ISEMPTY('x')")).toBe(false);
  });

  it('date functions', () => {
    expect(evalF("YEAR('2026-08-07')")).toBe(2026);
    expect(evalF("MONTH('2026-08-07')")).toBe(8);
    expect(evalF("DAY('2026-08-07')")).toBe(7);
    expect(evalF("DAYS_BETWEEN('2026-08-01', '2026-08-07')")).toBe(6);
    expect(evalF("ADD_DAYS('2026-08-07', 3)")).toBe('2026-08-10');
    expect(evalF("ADD_DAYS('not-a-date', 3)")).toBe(null);
  });

  it('TODAY / NOW evaluate to something date-like', () => {
    expect(evalF('TODAY()')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(evalF('NOW()')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('real-estate price helpers', () => {
    expect(evalF('LAKH(1.5)')).toBe(150_000);
    expect(evalF('CRORE(1.45)')).toBe(14_500_000);
    expect(evalF('TO_LAKH(1000000)')).toBe(10);
    expect(evalF('TO_CRORE(15000000)')).toBe(1.5);
    expect(evalF('PERCENT_OF(2000000, 5)')).toBe(100_000);
  });

  it('area helpers', () => {
    expect(evalF('SQFT_TO_SQM(1000)')).toBeCloseTo(92.903, 3);
    expect(evalF('SQM_TO_SQFT(92.903)')).toBeCloseTo(1000, 1);
  });

  it('supports nesting functions and fields', () => {
    expect(evalF('IF({area} > 0, ROUND({carpet} * {rate}, 0), 0)', { area: 100, carpet: 1000, rate: 6500 })).toBe(6_500_000);
  });
});

describe('error handling', () => {
  it('returns undefined on malformed input instead of throwing', () => {
    expect(evalF('2 +')).toBeUndefined();
    expect(evalF('{unclosed')).toBeUndefined();
    expect(evalF('(1 + 2')).toBeUndefined();
    expect(evalF('NOSUCHFUNC(1)')).toBeUndefined();
    expect(evalF('2 @ 3')).toBeUndefined();
    expect(evalF('')).toBeUndefined();
  });

  it('validateFormula reports validity for design-time checking', () => {
    expect(validateFormula('{price} * 0.05')).toEqual({ valid: true });
    expect(validateFormula('{price} *').valid).toBe(false);
    expect(validateFormula('(1 + 2').valid).toBe(false);
  });
});

describe('FORMULA_FUNCTIONS', () => {
  it('exposes the whitelist sorted', () => {
    expect(FORMULA_FUNCTIONS).toContain('CRORE');
    expect(FORMULA_FUNCTIONS).toContain('IF');
    expect([...FORMULA_FUNCTIONS].sort()).toEqual(FORMULA_FUNCTIONS);
  });
});
