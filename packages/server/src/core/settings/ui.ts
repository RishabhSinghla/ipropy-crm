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
  splitView: null,
};

/**
 * `{ module: { queue, header, form } }`, ignoring anything that is not that.
 *
 * An empty list is dropped rather than stored, so a malformed row can never
 * mean "show no fields". The split view's three lists each
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
      splitView: readSplitView(map.get('ui.split_view')),
    };
    return cached;
  } catch (err) {
    logger.warn({ err }, 'could not read UI settings, using defaults');
    return DEFAULTS;
  }
}
