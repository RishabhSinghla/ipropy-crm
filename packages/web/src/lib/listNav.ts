/**
 * Prev/next record navigation.
 *
 * ListView writes the id order of whatever it last rendered (table rows or
 * kanban cards, in fetch order) here; RecordDetail reads it to know what
 * "next" means without either page needing to pass state through routing.
 * sessionStorage rather than router state so a page refresh on the detail
 * view — or navigating there straight from search — doesn't lose the arrow
 * keys, as long as the list was viewed at some point this session.
 */
const KEY_PREFIX = 'ipropy.listNav.';

export interface ListNavState {
  ids: string[];
  /** Total matching the active view/filter/search, not merely this page. */
  total: number;
  /** One-based page that supplied `ids`. */
  page: number;
  pageSize: number;
}

export function saveListNav(moduleName: string, ids: string[], context?: Partial<Omit<ListNavState, 'ids'>>): void {
  try {
    sessionStorage.setItem(KEY_PREFIX + moduleName, JSON.stringify({
      ids,
      total: context?.total ?? ids.length,
      page: context?.page ?? 1,
      pageSize: context?.pageSize ?? (ids.length || 1),
    } satisfies ListNavState));
  } catch {
    // Storage can be unavailable (private browsing quirks) — arrow nav just won't work.
  }
}

export function loadListNav(moduleName: string): ListNavState {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + moduleName);
    if (!raw) return { ids: [], total: 0, page: 1, pageSize: 1 };
    const parsed = JSON.parse(raw) as ListNavState | string[];
    // Keep detail links opened during an older release functional.
    if (Array.isArray(parsed)) return { ids: parsed, total: parsed.length, page: 1, pageSize: parsed.length || 1 };
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids : [],
      total: Number.isFinite(parsed.total) ? parsed.total : parsed.ids?.length ?? 0,
      page: Number.isFinite(parsed.page) && parsed.page > 0 ? parsed.page : 1,
      pageSize: Number.isFinite(parsed.pageSize) && parsed.pageSize > 0 ? parsed.pageSize : (parsed.ids?.length || 1),
    };
  } catch {
    return { ids: [], total: 0, page: 1, pageSize: 1 };
  }
}
