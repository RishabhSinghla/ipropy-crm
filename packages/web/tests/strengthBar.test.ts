import { describe, expect, it } from 'vitest';
import { strengthFill } from '../src/lib/strengthBar';
describe('strength bar grades', () => {
  it('uses red below 50, yellow through 70, then green', () => {
    expect(strengthFill(49)).toBe('var(--strength-low)');
    expect(strengthFill(50)).toBe('var(--strength-mid)');
    expect(strengthFill(70)).toBe('var(--strength-mid)');
    expect(strengthFill(71)).toBe('var(--strength-high)');
  });
});
