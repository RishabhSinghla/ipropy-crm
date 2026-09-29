/**
 * The row of filter pills above a list.
 *
 * **28 September 2026, the owner:** *"Active Button Should Darker as Theme
 * Colour in Tool bar in All modules."* It used to be the other way round — the
 * pill that was on went lighter and took a ring — so these pin the direction
 * rather than the exact step.
 *
 * **A parallel session answered the same message with a light row** —
 * `bg-brand-50` at rest, `bg-brand-100` when on. That satisfies "the active
 * one is darker than the others" and reverses his own instruction of
 * 27 September (*"change these button colour into Dark Purple"*), which he did
 * not ask for. It also spelt its dark-mode fills with opacity modifiers
 * (`dark:bg-brand-900/70`), and **every brand step here is a bare `var()`** —
 * Tailwind cannot put an opacity into one, so those rules never enter the
 * stylesheet and the row keeps its light fill on a dark page. Both reasons are
 * why the dark row survived the merge.
 */
import { describe, expect, it } from 'vitest';
import { toolbarButton, toolbarCount } from '../src/lib/toolbarButton';

describe('list toolbar filters', () => {
  it('rests on the mid brand step, in white', () => {
    const classes = toolbarButton(false);
    expect(classes).toContain('bg-brand-700');
    expect(classes).toContain('text-white');
  });

  it('goes darker, not lighter, when the filter is narrowing the list', () => {
    expect(toolbarButton(true)).toContain('bg-brand-950');
    expect(toolbarButton(true)).not.toContain('bg-brand-700');
  });

  it('keeps the count on the same row of purple', () => {
    expect(toolbarCount()).toContain('bg-brand-700');
    expect(toolbarCount()).toContain('text-white');
  });

  it('never uses an opacity modifier, which compiles to nothing on these colours', () => {
    expect(`${toolbarButton(true)} ${toolbarButton(false)} ${toolbarCount()}`).not.toMatch(/-brand-\d+\/\d+/);
  });
});
