/**
 * How lists behave, as settings rather than as decisions buried in React.
 *
 * These ride along on `/api/auth/me`, which every client already fetches at
 * start-up, so switching one costs no extra request and no deploy. Read by the
 * web app in `lib/store.ts`.
 *
 * Both default to the safe answer if the database will not answer: no inline
 * editing, and open in a new tab. A settings read that fails should never make
 * the product *more* willing to change somebody's data.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import type { HeaderTab, QuickFilterSection, TaskBuzzerSettings, UiSettings } from '@ipropy/shared';

const DEFAULTS: UiSettings = {
  inlineEdit: false,
  openInNewTab: true,
  headerTabs: null,
  socialPosition: 'right',
  quickFilters: null,
  taskBuzzer: { on: true, everyMinutes: 15, onceOver: 50, closeAfterSeconds: 60 },
};

let cached: UiSettings | null = null;

export function invalidateUiSettings(): void {
  cached = null;
}

export async function uiSettings(): Promise<UiSettings> {
  if (cached) return cached;
  try {
    /*
      Every `ui.` row, rather than a list of names kept in step by hand.

      That list existed, and a setting was once added to the reader below
      without being added to it: fetched by nobody, read as absent, saved
      perfectly and changing nothing — exactly what a broken switch looks like. A prefix
      cannot fall behind: a new `ui.` setting needs a reader and nothing else.
    */
    const { rows } = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key LIKE 'ui.%'`,
    );
    const map = new Map(rows.map((r) => [r.key, r.value]));
    // Only an explicit boolean counts. A row that has never been saved, or one
    // holding a string, falls back rather than being coerced — "false" is truthy
    // and that would switch inline editing on for somebody who turned it off.
    const read = (key: string, fallback: boolean): boolean => {
      const v = map.get(key);
      return typeof v === 'boolean' ? v : fallback;
    };
    const tabs = map.get('ui.header_tabs');
    const position = map.get('ui.social_position');
    cached = {
      inlineEdit: read('ui.inline_edit', DEFAULTS.inlineEdit),
      openInNewTab: read('ui.open_in_new_tab', DEFAULTS.openInNewTab),
      // An array of well-shaped entries only; anything else reads as "not
      // arranged yet" and the header falls back to the shipped order.
      headerTabs: Array.isArray(tabs)
        ? (tabs as unknown[]).filter((t): t is HeaderTab =>
          Boolean(t) && typeof t === 'object'
          && ['dashboard', 'capture', 'chats', 'reports', 'whatsapp', 'module', 'link'].includes((t as HeaderTab).kind))
        : null,
      socialPosition: position === 'brand' || position === 'right' || position === 'hidden'
        ? position
        : DEFAULTS.socialPosition,
      quickFilters: readQuickFilters(map.get('ui.quick_filters')),
      taskBuzzer: readTaskBuzzer(map),
    };
    return cached;
  } catch (err) {
    logger.warn({ err }, 'could not read UI settings, using defaults');
    return DEFAULTS;
  }
}

const QUICK_KINDS = ['agent', 'list', 'stage', 'calls', 'task', 'values', 'range', 'date'];

/**
 * `{ module: sections[] }`, keeping only well-shaped sections. Anything else
 * reads as "not arranged yet", and the panel falls back to the shipped one.
 */
function readQuickFilters(value: unknown): Record<string, QuickFilterSection[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const arranged: Record<string, QuickFilterSection[]> = {};
  for (const [module, sections] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(sections)) continue;
    const wellShaped = sections.filter((section): section is QuickFilterSection =>
      Boolean(section) && typeof section === 'object'
      && typeof (section as QuickFilterSection).key === 'string'
      && QUICK_KINDS.includes((section as QuickFilterSection).kind));
    if (wellShaped.length) arranged[module] = wellShaped;
  }
  return Object.keys(arranged).length ? arranged : null;
}

/**
 * The buzzer's four numbers, each held inside a range a person could live with.
 *
 * A typo in Settings must not become a popup every second, or one that closes
 * before anybody can read it. Anything out of range or not a number falls back
 * to what the owner asked for.
 */
export function readTaskBuzzer(map: Map<string, unknown>): TaskBuzzerSettings {
  const fallback = DEFAULTS.taskBuzzer;
  const whole = (key: string, min: number, max: number, otherwise: number): number => {
    const value = Number(map.get(key));
    return Number.isInteger(value) && value >= min && value <= max ? value : otherwise;
  };
  const on = map.get('ui.task_buzzer_on');
  return {
    on: typeof on === 'boolean' ? on : fallback.on,
    everyMinutes: whole('ui.task_buzzer_every_minutes', 1, 240, fallback.everyMinutes),
    onceOver: whole('ui.task_buzzer_once_over', 1, 10_000, fallback.onceOver),
    closeAfterSeconds: whole('ui.task_buzzer_close_after_seconds', 10, 600, fallback.closeAfterSeconds),
  };
}
