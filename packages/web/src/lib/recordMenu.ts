/**
 * The record's own menu bar: what is on it, in what order, and what spills
 * into "More".
 *
 * **2 October 2026, the owner:** *"Please Make Menu tab Drag and drop in menu
 * bar, so that user can set menu button and they can choose button as per
 * their priority and if button too much, then 'More hamburger' will be shown
 * in ment bar … And all tab of activity move/merge in to menu bar i.e All,
 * Comment, Messages, Calls, Changes, Files."*
 *
 * Two bars became one. The record had **tabs** (Activity, Matching, Files,
 * Calls, WhatsApp) and the activity stream underneath had its **own** row of
 * chips (All, Comments, Messages, Calls, Changes, Files) — so Calls and Files
 * appeared twice, two rows apart, meaning different things. One list now, and
 * an entry is either a tab of its own or the stream filtered to one kind.
 *
 * Pure, and tested as such: this file decides nothing about how a menu looks.
 */

/** A record tab that draws its own screen. */
export type RecordTabKey = 'timeline' | 'matching' | 'files' | 'calls' | 'whatsapp';

/** The stream, narrowed to one kind of thing that happened. */
export type ActivityKind = 'comment' | 'message' | 'audit';

export type MenuKey = RecordTabKey | ActivityKind;

/** How many sit on the bar itself. The rest go under "More". */
export const ON_THE_BAR = 5;

const MENU_ORDER_KEY = 'ipropy.recordMenu';

/**
 * The order a module opens with, before anybody drags anything.
 *
 * Comments first, because it is where a rep starts — his own screenshot opens
 * on it. `timeline` ("All") sits past the fifth on purpose: it is the one a
 * rep reaches for least, since every other entry is a narrower view of it.
 */
export const DEFAULT_ORDER: MenuKey[] = [
  'comment', 'matching', 'files', 'calls', 'whatsapp', 'message', 'audit', 'timeline',
];

/** Which of the stream's kinds an entry shows, or `null` for a tab of its own. */
export function activityKindOf(key: MenuKey): ActivityKind | null {
  return key === 'comment' || key === 'message' || key === 'audit' ? key : null;
}

/**
 * The saved order for a module, cleaned against what that module actually
 * offers.
 *
 * **Anything stored but no longer available is dropped, and anything available
 * but not stored is appended.** A saved order is a person's arrangement, and
 * it outlives the build that wrote it: a module that loses its Matching tab
 * must not leave a dead button, and one that gains an entry must not hide it
 * for everybody who has ever dragged anything. That is the same rule
 * `arrangeHeaderTabs` holds to, applied per person instead of per
 * organisation.
 */
export function arrangeRecordMenu(available: MenuKey[], saved: MenuKey[] | null): MenuKey[] {
  const offered = new Set(available);
  const kept = (saved ?? []).filter((key) => offered.has(key));
  const seen = new Set(kept);
  const appended = DEFAULT_ORDER.filter((key) => offered.has(key) && !seen.has(key));
  // A module can offer something neither list names — a new tab, this build.
  const rest = available.filter((key) => !seen.has(key) && !appended.includes(key));
  return [...kept, ...appended, ...rest];
}

/** The first five, and the ones that spill into "More". */
export function splitMenu(order: MenuKey[]): { bar: MenuKey[]; more: MenuKey[] } {
  return { bar: order.slice(0, ON_THE_BAR), more: order.slice(ON_THE_BAR) };
}

/**
 * The order with one entry moved to another position.
 *
 * Pure, because dragging is the one interaction nobody can check by reading:
 * the browser gives you two indexes and everything else is arithmetic that is
 * easy to get subtly wrong — a drop that lands one place short is the classic.
 */
export function moveEntry(order: MenuKey[], from: number, to: number): MenuKey[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** This browser's arrangement for one module. */
export function loadRecordMenu(module: string): MenuKey[] | null {
  try {
    const raw = localStorage.getItem(`${MENU_ORDER_KEY}.${module}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MenuKey[]) : null;
  } catch {
    // A private window and blocked site data both throw. The default order is
    // a perfectly good answer; losing an arrangement is not worth a crash.
    return null;
  }
}

export function saveRecordMenu(module: string, order: MenuKey[]): void {
  try { localStorage.setItem(`${MENU_ORDER_KEY}.${module}`, JSON.stringify(order)); } catch { /* see loadRecordMenu */ }
}
