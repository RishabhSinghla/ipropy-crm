import { describe, expect, it } from 'vitest';
import { toolbarButton, toolbarCount } from '../src/lib/toolbarButton';

describe('list toolbar filters', () => {
  it('uses a light theme surface and a darker theme border at rest', () => {
    const classes = toolbarButton(false);
    expect(classes).toContain('bg-brand-50');
    expect(classes).toContain('border-brand-300');
    expect(classes).toContain('text-brand-800');
    expect(classes).not.toContain('bg-brand-900 hover:bg-brand-800');
  });

  it('makes an active filter one tint stronger without becoming solid', () => {
    const classes = toolbarButton(true);
    expect(classes).toContain('bg-brand-100');
    expect(classes).toContain('border-brand-500');
    expect(classes).toContain('text-brand-900');
  });

  it('keeps the count readable on the same light surface', () => {
    expect(toolbarCount()).toContain('bg-brand-100');
    expect(toolbarCount()).toContain('text-brand-800');
  });
});
