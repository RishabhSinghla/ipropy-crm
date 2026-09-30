import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import {
  arrangeQuickSections, defaultQuickSections, localDayBounds, pickIsActive, quickPickConditions, topValues,
} from '../src/lib/quickFilters';

function field(name: string, uitype: string, extra: Partial<FieldMeta> = {}): FieldMeta {
  return { name, label: name, uitype, isActive: true, displayType: 'visible', ...extra } as unknown as FieldMeta;
}

const owner = field('assigned_to', 'owner');
const stage = field('status', 'picklist');
const task = field('next_followup_at', 'date');
const FIELDS = [
  owner, stage, task,
  field('full_name', 'string'),
  field('lost_reason', 'picklist'),
  field('budget', 'currency'),
  field('configuration', 'multipicklist'),
  field('area_size', 'area'),
  field('hidden_one', 'picklist', { displayType: 'hidden' } as Partial<FieldMeta>),
];

describe('the panel a module gets when nobody has arranged it', () => {
  const sections = defaultQuickSections(FIELDS, { ownerField: owner, stageField: stage, taskField: task });
  const keys = sections.map((section) => section.key);

  it('opens with the CRM’s own questions, then created and updated', () => {
    expect(keys.slice(0, 7)).toEqual(['agent', 'list', 'stage', 'calls', 'task', 'created_at', 'updated_at']);
  });

  it('offers money and sizes as sliders before lists', () => {
    expect(sections.find((s) => s.key === 'budget')?.kind).toBe('range');
    expect(sections.find((s) => s.key === 'area_size')?.kind).toBe('range');
    expect(keys.indexOf('area_size')).toBeLessThan(keys.indexOf('lost_reason'));
  });

  it('never offers the owner, stage or chase date twice, a text field, or a hidden field', () => {
    for (const name of ['assigned_to', 'status', 'next_followup_at', 'full_name', 'hidden_one']) {
      expect(keys).not.toContain(name);
    }
  });

  it('leaves out the sections a module has no field for', () => {
    const bare = defaultQuickSections([field('city', 'picklist')], {}).map((s) => s.key);
    expect(bare).not.toContain('agent');
    expect(bare).not.toContain('stage');
    expect(bare).not.toContain('task');
    expect(bare).toContain('city');
  });
});

describe('a saved arrangement meeting the module as it is now', () => {
  const defaults = defaultQuickSections(FIELDS, { ownerField: owner, stageField: stage, taskField: task });

  it('keeps the admin’s order, names and switches', () => {
    const arranged = arrangeQuickSections(
      [{ key: 'budget', kind: 'range', label: 'Budget', open: true }, { key: 'agent', kind: 'agent', hidden: true }],
      defaults,
    );
    expect(arranged[0]).toMatchObject({ key: 'budget', label: 'Budget', open: true });
    expect(arranged[1]).toMatchObject({ key: 'agent', hidden: true });
  });

  it('drops a section whose field has gone, and appends a field added since', () => {
    const arranged = arrangeQuickSections([{ key: 'deleted_field', kind: 'values' }, { key: 'budget', kind: 'range' }], defaults);
    expect(arranged.map((s) => s.key)).not.toContain('deleted_field');
    expect(arranged[0]!.key).toBe('budget');
    expect(arranged.map((s) => s.key)).toContain('lost_reason');
  });

  it('takes the control from the field as it is now, not as it was saved', () => {
    const arranged = arrangeQuickSections([{ key: 'budget', kind: 'values' }], defaults);
    expect(arranged[0]!.kind).toBe('range');
  });

  it('is the shipped arrangement when nothing is saved', () => {
    expect(arrangeQuickSections(undefined, defaults)).toBe(defaults);
  });
});

describe('what a choice turns into', () => {
  const byName = new Map(FIELDS.map((f) => [f.name, f]));

  it('ticks on a list are one "is one of", and on a multi-choice field "has any of"', () => {
    const conditions = quickPickConditions({
      lost_reason: { kind: 'values', values: ['Budget'] },
      configuration: { kind: 'values', values: ['3 BHK', '4 BHK'] },
    }, byName);
    expect(conditions).toContainEqual({ field: 'lost_reason', operator: 'in', value: ['Budget'] });
    expect(conditions).toContainEqual({ field: 'configuration', operator: 'has_any', value: ['3 BHK', '4 BHK'] });
  });

  it('a slider gives a floor, a ceiling, or both', () => {
    expect(quickPickConditions({ budget: { kind: 'range', min: 5_000_000 } }, byName))
      .toEqual([{ field: 'budget', operator: 'greater_or_equal', value: 5_000_000 }]);
    expect(quickPickConditions({ budget: { kind: 'range', min: 1, max: 2 } }, byName)).toHaveLength(2);
  });

  it('a date preset is the grammar’s own word for it', () => {
    expect(quickPickConditions({ created_at: { kind: 'date', preset: 'yesterday' } }, byName))
      .toEqual([{ field: 'created_at', operator: 'yesterday' }]);
  });

  it('a picked day is the whole local day on a timestamp, and the day itself on a date', () => {
    const [stamp] = quickPickConditions({ created_at: { kind: 'date', on: '2026-10-01' } }, byName);
    expect(stamp).toMatchObject({ field: 'created_at', operator: 'between' });
    expect(stamp!.value).toBe(localDayBounds('2026-10-01')[0]);
    expect(quickPickConditions({ next_followup_at: { kind: 'date', on: '2026-10-01' } }, byName))
      .toEqual([{ field: 'next_followup_at', operator: 'equals', value: '2026-10-01' }]);
  });

  it('an empty choice narrows nothing', () => {
    expect(quickPickConditions({ lost_reason: { kind: 'values', values: [] }, budget: { kind: 'range' } }, byName)).toEqual([]);
    expect(pickIsActive({ kind: 'date' })).toBe(false);
  });
});

describe('the top few of a long list', () => {
  const options = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((value) => ({ value }));

  it('shows the first N', () => {
    expect(topValues(options, [], 5).map((o) => o.value)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('never hides a ticked value behind the search', () => {
    expect(topValues(options, ['g'], 5).map((o) => o.value)).toEqual(['g', 'a', 'b', 'c', 'd']);
  });
});

describe('parseTypedAmount', () => {
  it('reads plain numbers with either comma grouping', async () => {
    const { parseTypedAmount } = await import('../src/lib/quickFilters');
    expect(parseTypedAmount('1450')).toBe(1450);
    expect(parseTypedAmount('12,00,000')).toBe(1_200_000);
    expect(parseTypedAmount('1,200,000')).toBe(1_200_000);
    expect(parseTypedAmount('₹ 5000')).toBe(5000);
  });
  it('reads crore, lakh and thousand the way people type them', async () => {
    const { parseTypedAmount } = await import('../src/lib/quickFilters');
    expect(parseTypedAmount('1.45 cr')).toBe(14_500_000);
    expect(parseTypedAmount('2 Crore')).toBe(20_000_000);
    expect(parseTypedAmount('45L')).toBe(4_500_000);
    expect(parseTypedAmount('45 lakh')).toBe(4_500_000);
    expect(parseTypedAmount('80k')).toBe(80_000);
  });
  it('treats an empty or unreadable box as no limit, never as zero', async () => {
    const { parseTypedAmount } = await import('../src/lib/quickFilters');
    expect(parseTypedAmount('')).toBeUndefined();
    expect(parseTypedAmount('  ')).toBeUndefined();
    expect(parseTypedAmount('about two')).toBeUndefined();
  });
});
