/**
 * The row of filter pills above a list.
 *
 * **29 September 2026, the owner:** *"we need Normal Toolbar Button in Light
 * Color when button not selected or inactive but if we we Select or active a
 * button or filter on a Button Then Theme Dark Color in toolbar and text
 * colour also change to white or lighter."*
 *
 * That is the third arrangement of this row in three days — dark throughout,
 * then the active one darkest, now light until something is narrowing the
 * list. These pin the shape of the decision rather than the exact step, so a
 * later change of mind moves one line and not five assertions.
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

  it('fills with the theme and reverses to white once it is narrowing the list', () => {
    const on = toolbarButton(true);
    expect(on).toContain('bg-brand-700');
    expect(on).toContain('text-white');
    expect(on).not.toContain('bg-brand-50');
  });

  it('moves the count chip with the fill under it', () => {
    expect(toolbarCount(false)).toContain('bg-brand-100');
    expect(toolbarCount(true)).toContain('text-white');
    expect(toolbarCount(true)).not.toContain('bg-brand-100');
  });

  it('never uses an opacity modifier, which compiles to nothing on these colours', () => {
    /*
      Every brand step resolves to a bare `var(--brand-…)`, so Tailwind has no
      channels to put an opacity into and the rule never enters the stylesheet
      — the light rule is then the only one left and the row keeps its light
      fill on a dark page. Only a browser in dark mode shows that.
    */
    const all = [toolbarButton(true), toolbarButton(false), toolbarCount(true), toolbarCount(false)].join(' ');
    expect(all).not.toMatch(/-brand-\d+\/\d+/);
  });
});
