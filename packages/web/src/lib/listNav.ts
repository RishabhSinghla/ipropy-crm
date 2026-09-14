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

export function saveListNav(moduleName: string, ids: string[]): void {
  try {
    sessionStorage.setItem(KEY_PREFIX + moduleName, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable (private browsing quirks) — arrow nav just won't work.
  }
}

export function loadListNav(moduleName: string): string[] {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + moduleName);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
