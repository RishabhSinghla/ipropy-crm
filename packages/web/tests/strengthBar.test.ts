/**
 * The completeness bar's three bands.
 *
 * The owner asked for red to the bar's 40% mark, amber to 70%, green after —
 * so the boundaries belong to the track and the fill has to place them itself.
 * That division is the only arithmetic here and it is the only thing that can
 * be wrong, which is why it lives in a function a `node` test can read.
 */
import { describe, expect, it } from 'vitest';
import { strengthFill, STRENGTH_STOPS } from '../src/lib/strengthBar';

describe('strengthFill', () => {
  it('is red alone below the first boundary', () => {
    expect(strengthFill(0)).toBe('var(--strength-low)');
    expect(strengthFill(12)).toBe('var(--strength-low)');
    expect(strengthFill(STRENGTH_STOPS.mid)).toBe('var(--strength-low)');
  });

  it('adds amber once past it, and keeps red over the first 40% of the track', () => {
    const fill = strengthFill(50);
    expect(fill).toContain('var(--strength-low)');
    expect(fill).toContain('var(--strength-mid)');
    expect(fill).not.toContain('var(--strength-high)');
    // 40 of a 50-wide fill is 80% along it.
    expect(fill).toContain('80%');
  });

  it('shows all three once past the second boundary', () => {
    const fill = strengthFill(80);
    expect(fill).toContain('var(--strength-low)');
    expect(fill).toContain('var(--strength-mid)');
    expect(fill).toContain('var(--strength-high)');
    // 40 and 70 of an 80-wide fill are half and seven eighths along it.
    expect(fill).toContain('50%');
    expect(fill).toContain('87.5%');
  });

  it('puts the boundaries at 40 and 70 of the whole bar when the bar is full', () => {
    const fill = strengthFill(100);
    expect(fill).toContain('40%');
    expect(fill).toContain('70%');
  });

  it('never divides by zero and never reads past either end', () => {
    expect(() => strengthFill(-20)).not.toThrow();
    expect(strengthFill(-20)).toBe('var(--strength-low)');
    expect(strengthFill(140)).toBe(strengthFill(100));
  });
});
