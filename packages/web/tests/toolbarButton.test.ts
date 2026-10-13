/**
 * The row of filter pills above a list.
 *
 * Inactive chips stay white and quiet; selected chips use a pale brand tint
 * and a clear border so the active state is easy to spot without a dark block.
 */
import { describe, expect, it } from 'vitest';
import { toolbarButton, toolbarCount } from '../src/lib/toolbarButton';

describe('list toolbar filters', () => {
  it('rests light, in the brand rather than in slate', () => {
    const rest = toolbarButton(false);
    expect(rest).toContain('bg-brand-50');
    expect(rest).toContain('text-brand-800');
    expect(rest).not.toContain('text-white');
  });

  it('uses a soft brand highlight once it is narrowing the list', () => {
    const on = toolbarButton(true);
    expect(on).toContain('bg-brand-100');
    expect(on).toContain('text-brand-900');
    expect(on).toContain('border-brand-300');
    expect(on).not.toContain('bg-brand-700');
  });

  it('moves the count chip with the fill under it', () => {
    expect(toolbarCount(false)).toContain('bg-slate-100');
    expect(toolbarCount(true)).toContain('bg-white');
    expect(toolbarCount(true)).toContain('text-brand-900');
  });

  it('keeps the light selected and inactive states free from dark-theme overrides', () => {
    const all = [toolbarButton(true), toolbarButton(false), toolbarCount(true), toolbarCount(false)].join(' ');
    expect(all).not.toMatch(/dark:/);
  });
});
