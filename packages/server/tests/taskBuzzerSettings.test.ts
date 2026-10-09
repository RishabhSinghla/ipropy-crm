/** The buzzer's numbers are held inside a range a person could live with. */
import { describe, expect, it } from 'vitest';
import { readTaskBuzzer } from '../src/core/settings/ui.js';

describe('readTaskBuzzer', () => {
  it("falls back to the owner's numbers when nothing is saved", () => {
    expect(readTaskBuzzer(new Map())).toEqual({ on: true, everyMinutes: 15, onceOver: 50, closeAfterSeconds: 60 });
  });

  it('takes what an admin saved', () => {
    const saved = new Map<string, unknown>([
      ['ui.task_buzzer_on', false], ['ui.task_buzzer_every_minutes', 30],
      ['ui.task_buzzer_once_over', 80], ['ui.task_buzzer_close_after_seconds', 45],
    ]);
    expect(readTaskBuzzer(saved)).toEqual({ on: false, everyMinutes: 30, onceOver: 80, closeAfterSeconds: 45 });
  });

  it('refuses a typo that would popup every second or close before anybody reads it', () => {
    const saved = new Map<string, unknown>([
      ['ui.task_buzzer_on', 'false'], ['ui.task_buzzer_every_minutes', 0],
      ['ui.task_buzzer_once_over', 'lots'], ['ui.task_buzzer_close_after_seconds', 2],
    ]);
    expect(readTaskBuzzer(saved)).toEqual({ on: true, everyMinutes: 15, onceOver: 50, closeAfterSeconds: 60 });
  });
});
