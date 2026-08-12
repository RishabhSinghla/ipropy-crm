import { describe, expect, it } from 'vitest';
import { MIN_OUTPUT_TOKENS, outputTokenLimit } from '../../src/ai/client.js';

describe('AI output allowance', () => {
  it('protects small feature prompts from reasoning-only empty responses', () => {
    expect(outputTokenLimit(400, 4096)).toBe(MIN_OUTPUT_TOKENS);
    expect(outputTokenLimit(undefined, 1200)).toBe(MIN_OUTPUT_TOKENS);
  });

  it('keeps a larger administrator or feature ceiling unchanged', () => {
    expect(outputTokenLimit(6000, 4096)).toBe(6000);
    expect(outputTokenLimit(undefined, 8192)).toBe(8192);
  });
});
