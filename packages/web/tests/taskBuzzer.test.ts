/**
 * The today-task buzzer's rules, as the owner gave them on 9 October 2026:
 * every fifteen minutes, first task to last; over fifty, each lead once a day
 * and closing after sixty seconds; at or under fifty, every round until done.
 */
import { describe, expect, it } from 'vitest';
import type { FieldMeta, TaskBuzzerSettings } from '@ipropy/shared';
import {
  closesAfter, isBusyDay, nextRoundAt, readMemory, taskDateFields, todaysTasksFilter, type TodayTask, whichToShow,
} from '../src/lib/taskBuzzer';

const SETTINGS: TaskBuzzerSettings = { on: true, everyMinutes: 15, onceOver: 50, closeAfterSeconds: 60 };

function tasks(n: number): TodayTask[] {
  return Array.from({ length: n }, (_, i) => ({ module: 'leads', moduleLabel: 'Contact', id: `r${i}`, label: `Lead ${i}` }));
}

function field(over: Partial<FieldMeta>): FieldMeta {
  return { name: 'x', label: 'X', uitype: 'text', isActive: true, config: {}, ...over } as FieldMeta;
}

describe('which tasks pop up', () => {
  it('shows every task, every round, at fifty or fewer — even ones already shown', () => {
    const shown = new Set(['r0', 'r1']);
    expect(whichToShow(tasks(50), shown, SETTINGS).map((t) => t.id)).toEqual(tasks(50).map((t) => t.id));
  });

  it('over fifty, shows each lead once a day, in order', () => {
    const shown = new Set(['r0', 'r2']);
    const due = whichToShow(tasks(51), shown, SETTINGS);
    expect(due).toHaveLength(49);
    expect(due[0]!.id).toBe('r1');
    expect(due[1]!.id).toBe('r3');
  });

  it('closes a popup by itself only on a busy day', () => {
    expect(isBusyDay(50, SETTINGS)).toBe(false);
    expect(closesAfter(50, SETTINGS)).toBeNull();
    expect(closesAfter(51, SETTINGS)).toBe(60);
  });

  it('starts the next round fifteen minutes after this one ended', () => {
    expect(nextRoundAt(1_000_000, SETTINGS)).toBe(1_000_000 + 15 * 60_000);
  });
});

describe('what counts as a task', () => {
  it('is the follow-up date plus any date an admin marked as due, never a field named here', () => {
    const fields = [
      field({ name: 'next_followup_at', columnName: 'next_followup_at', uitype: 'date' }),
      field({ name: 'site_visit_on', uitype: 'date', config: { dueDate: true } }),
      field({ name: 'birthday', uitype: 'date' }),
      field({ name: 'old_visit', uitype: 'date', config: { dueDate: true }, isActive: false }),
    ];
    expect(taskDateFields(fields).map((f) => f.name)).toEqual(['next_followup_at', 'site_visit_on']);
  });

  it('counts the follow-up once even when it is also marked as due', () => {
    const fields = [field({ name: 'next_followup_at', columnName: 'next_followup_at', uitype: 'date', config: { dueDate: true } })];
    expect(taskDateFields(fields)).toHaveLength(1);
  });

  it('asks for my records whose task date is today', () => {
    const dates = [field({ name: 'next_followup_at', uitype: 'date' }), field({ name: 'site_visit_on', uitype: 'date' })];
    expect(todaysTasksFilter(dates, 'assigned_to', 'u1')).toEqual({
      logic: 'AND',
      conditions: [
        { field: 'assigned_to', operator: 'equals', value: 'u1' },
        { logic: 'OR', conditions: [
          { field: 'next_followup_at', operator: 'today' },
          { field: 'site_visit_on', operator: 'today' },
        ] },
      ],
    });
    expect(todaysTasksFilter([], 'assigned_to', 'u1')).toBeNull();
  });
});

describe('what the browser remembers', () => {
  it('starts clean when storage cannot be read, rather than throwing', () => {
    expect(readMemory('u1')).toEqual({ shown: [], nextAt: null });
  });
});
