/**
 * How many rows a list shows, remembered per module.
 *
 * A page size is a working habit, not a property of the link you followed: a
 * rep who works 100 at a time means it tomorrow too, and on every tab of the
 * module. It still travels in the URL so a shared link opens the same way, but
 * the stored value is what an ordinary visit starts from.
 *
 * Kept per module because the habit differs by module — a 200-row contact
 * sweep and a 25-row inventory browse are different jobs.
 *
 * localStorage throws outright in a locked-down browser or a private window,
 * so every read and write is guarded and the list falls back to the default.
 */
const KEY = 'ipropy.pagesize.global';

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200, 500] as const;
export const DEFAULT_PAGE_SIZE = 25;

function clamp(value: number): number | null {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value) ? value : null;
}

export function loadPageSize(_module?: string): number {
  try {
    return clamp(Number(localStorage.getItem(KEY))) ?? DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

export function savePageSize(_module: string | undefined, size: number): void {
  try {
    if (size === DEFAULT_PAGE_SIZE) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(size));
  } catch { /* a browser that refuses storage still gets a working list */ }
}
