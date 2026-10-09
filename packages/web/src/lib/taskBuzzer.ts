/**
 * The today-task buzzer's decisions, kept apart from the screen so a test can
 * read them without a browser.
 *
 * **9 October 2026, the owner:** *"in every 15 minute … first task to last task
 * … every lead form auto open like popup … only once time per day / per lead if
 * task more then 50 records, the form will be closed after 60 seconds … if task
 * below then 50 then remind regular after 15 minute multiple time in a day …
 * with a buzzer sound also."*
 *
 * The rules, in plain words:
 *
 * * A **task** is a record you are assigned whose follow-up date is today.
 *   Which date counts is metadata — the module's Next Follow-up, plus any date
 *   an admin has marked as a due date (a planned site visit, say). No field is
 *   named here.
 * * A **round** walks every task, first to last. The next round starts
 *   `everyMinutes` after the last one ended.
 * * **More than `onceOver` tasks:** each record pops up once that day, and
 *   every popup closes itself after `closeAfterSeconds`.
 * * **At or under `onceOver`:** every task pops up every round, and a popup
 *   stays until the rep moves on. A task leaves the list only when its date is
 *   moved off today — which is the whole point.
 */
import type { FieldMeta, FilterGroup, TaskBuzzerSettings } from '@ipropy/shared';
import { followUpFieldOf } from './fields';
import { localDay } from './followUpDates';

/** One record due today, as the popup needs it. */
export interface TodayTask {
  module: string;
  moduleLabel: string;
  id: string;
  label: string;
}

/** The dates that make a record "due today" in this module. */
export function taskDateFields(fields: FieldMeta[]): FieldMeta[] {
  const followUp = followUpFieldOf(fields);
  const marked = fields.filter((field) => field.isActive !== false
    && (field.uitype === 'date' || field.uitype === 'datetime')
    && Boolean(field.config?.dueDate));
  const all = followUp ? [followUp, ...marked] : marked;
  return all.filter((field, index) => all.findIndex((other) => other.name === field.name) === index);
}

/** Assigned to this person, and any task date is today. Null when the module has no task date. */
export function todaysTasksFilter(dateFields: FieldMeta[], ownerField: string, userId: string): FilterGroup | null {
  if (!dateFields.length) return null;
  return {
    logic: 'AND',
    conditions: [
      { field: ownerField, operator: 'equals', value: userId },
      { logic: 'OR', conditions: dateFields.map((field) => ({ field: field.name, operator: 'today' as const })) },
    ],
  };
}

/** Which tasks pop up this round, in order. */
export function whichToShow(tasks: TodayTask[], shownToday: ReadonlySet<string>, settings: TaskBuzzerSettings): TodayTask[] {
  if (!isBusyDay(tasks.length, settings)) return tasks;
  return tasks.filter((task) => !shownToday.has(task.id));
}

/** Over the line, a lead pops up once a day and each popup closes itself. */
export function isBusyDay(taskCount: number, settings: TaskBuzzerSettings): boolean {
  return taskCount > settings.onceOver;
}

/** Seconds before this popup closes on its own, or null when it waits for the rep. */
export function closesAfter(taskCount: number, settings: TaskBuzzerSettings): number | null {
  return isBusyDay(taskCount, settings) ? settings.closeAfterSeconds : null;
}

/** When the next round starts, given when this one ended. */
export function nextRoundAt(endedAt: number, settings: TaskBuzzerSettings): number {
  return endedAt + settings.everyMinutes * 60_000;
}

/** A minute after opening the CRM — long enough to sit down, short enough to matter. */
export const FIRST_ROUND_AFTER_MS = 60_000;

/**
 * What this browser remembers about today's buzzer, per person.
 *
 * Kept in the browser because it is about this screen: which records have
 * already popped up today, and when the next round is due — so reloading a
 * page neither restarts the clock nor shows a busy day's leads twice.
 * Keyed by the day, so tomorrow starts clean on its own.
 */
export interface BuzzerMemory {
  shown: string[];
  nextAt: number | null;
}

function memoryKey(userId: string, now: Date): string {
  return `ipropy.taskBuzzer.${userId}.${localDay(now)}`;
}

export function readMemory(userId: string, now: Date = new Date()): BuzzerMemory {
  try {
    const saved = JSON.parse(localStorage.getItem(memoryKey(userId, now)) ?? 'null') as Partial<BuzzerMemory> | null;
    return {
      shown: Array.isArray(saved?.shown) ? saved.shown.filter((id): id is string => typeof id === 'string') : [],
      nextAt: typeof saved?.nextAt === 'number' ? saved.nextAt : null,
    };
  } catch {
    return { shown: [], nextAt: null };
  }
}

export function writeMemory(userId: string, memory: BuzzerMemory, now: Date = new Date()): void {
  try {
    localStorage.setItem(memoryKey(userId, now), JSON.stringify(memory));
  } catch {
    // A private window or blocked storage: the buzzer still runs, it just forgets on reload.
  }
}
