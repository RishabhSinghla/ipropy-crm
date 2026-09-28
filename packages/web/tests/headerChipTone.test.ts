import { describe, expect, it } from 'vitest';
import { HEADER_CHIP_SHAPE, HEADER_CHIP_TONE } from '../src/lib/headerChip';

describe('record header chip', () => {
  it('has the same rounded height and weight for every fact', () => {
    expect(HEADER_CHIP_SHAPE).toContain('h-8');
    expect(HEADER_CHIP_SHAPE).toContain('rounded-full');
    expect(HEADER_CHIP_SHAPE).toContain('font-bold');
  });

  it('uses one solid charcoal tone for non-status facts', () => {
    expect(HEADER_CHIP_TONE).toContain('bg-slate-700');
    expect(HEADER_CHIP_TONE).toContain('text-white');
  });
});
