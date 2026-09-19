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
import type { HeaderTab, SplitViewLayout, UiSettings } from '@ipropy/shared';

const DEFAULTS: UiSettings = {
  inlineEdit: false,
  openInNewTab: true,
  headerTabs: null,
  socialPosition: 'right',
  listColumns: null,
  splitView: null,
};

/**
 * `{ module: [field, …] }`, ignoring anything that is not that.
 *
 * Exported for its tests: this is the one place a bad settings row is stopped
 * from reaching every table in the CRM.
 */
export function readColumns(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [module, columns] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(columns)) continue;
    const names = columns.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
    if (names.length) out[module] = names;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * `{ module: { queue, header, form } }`, ignoring anything that is not that.
 *
 * Same job as `readColumns` and the same rule: an empty list is dropped rather
 * than stored, so a malformed row can never mean "show no fields". Here that
 * matters more than it does for a table — the split view's three lists each
 * fall back to something sensible when absent (the flagged subtitle fields,
 * the Layout Designer's header, its blocks), and an empty array would override
 * that fallback with nothing at all.
 *
 * Exported for its tests, which are the only place this shape is proved.
 */
export function readSplitView(value: unknown): Record<string, SplitViewLayout> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const names = (list: unknown): string[] => (Array.isArray(list)
    ? list.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : []);

  const out: Record<string, SplitViewLayout> = {};
  for (const [module, panes] of Object.entries(value as Record<string, unknown>)) {
    if (!panes || typeof panes !== 'object' || Array.isArray(panes)) continue;
    const row = panes as Record<string, unknown>;
    const layout: SplitViewLayout = {
      queue: names(row.queue),
      header: names(row.header),
      form: names(row.form),
    };
    // A module with nothing chosen anywhere is the same as no entry at all.
    if (layout.queue.length || layout.header.length || layout.form.length) out[module] = layout;
  }
  return Object.keys(out).length ? out : null;
}

let cached: UiSettings | null = null;

export function invalidateUiSettings(): void {
  cached = null;
}

export async function uiSettings(): Promise<UiSettings> {
  if (cached) return cached;
  try {
    const { rows } = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`,
      [['ui.inline_edit', 'ui.open_in_new_tab', 'ui.header_tabs', 'ui.social_position',
        'ui.list_columns', 'ui.split_view']],
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
          && ['dashboard', 'capture', 'chats', 'reports', 'module', 'link'].includes((t as HeaderTab).kind))
        : null,
      socialPosition: position === 'brand' || position === 'right' || position === 'hidden'
        ? position
        : DEFAULTS.socialPosition,
      /*
        `{ module: [field, …] }` and nothing else. A malformed row falls back
        to the shipped defaults rather than to an empty array — an empty array
        is a *decision* ("show no columns") and a table with no columns is not
        something a bad settings row should be able to cause.
      */
      listColumns: readColumns(map.get('ui.list_columns')),
      splitView: readSplitView(map.get('ui.split_view')),
    };
    return cached;
  } catch (err) {
    logger.warn({ err }, 'could not read UI settings, using defaults');
    return DEFAULTS;
  }
}
