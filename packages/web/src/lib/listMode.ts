/**
 * Which way a list opens: the split view, the table, or the board.
 *
 * The owner asked for the desk to be what everybody lands on, in both modules,
 * with anybody free to switch. So the order is: what this person last chose on
 * this module, then what the saved view explicitly asks for, then the desk.
 *
 * Per person and per module, because it is a working habit rather than a
 * property of the data — somebody working a call queue wants the desk, and the
 * same person exporting a hundred rows wants the table, on the same list.
 *
 * Stored in the browser and not on the record: it changes several times a day,
 * it is nobody else's business, and a setting that needs a round trip to the
 * server to remember which way you like your list is a setting that will be
 * slow at exactly the wrong moment.
 *
 * localStorage throws outright in a locked-down browser or a private window,
 * so every read and write is guarded and the list falls back to the default.
 */
/*
  `ipropy` is the split view's *stored* name and stays that way.

  It is the key in every saved view, in every browser that has remembered a
  choice, and in the e2e specs' storage state — renaming the value would make
  all of them read as "never chosen" and quietly move everybody back to the
  default. The same reason the `leads` module is still called `leads` while
  the screen says Contacts: the label is what people read, the name is what
  things are stored under.
*/
export type ListMode = 'table' | 'kanban' | 'ipropy';

/** What a list opens as when nobody has said otherwise. */
export const DEFAULT_LIST_MODE: ListMode = 'ipropy';

const KEY = (module: string | undefined): string => `ipropy.listmode.${module ?? 'global'}`;

function valid(value: string | null): ListMode | null {
  return value === 'table' || value === 'kanban' || value === 'ipropy' ? value : null;
}

/** This person's own choice on this module, or null when they have never made one. */
export function loadListMode(module: string | undefined): ListMode | null {
  try {
    return valid(localStorage.getItem(KEY(module)));
  } catch {
    return null;
  }
}

export function saveListMode(module: string | undefined, mode: ListMode): void {
  try {
    localStorage.setItem(KEY(module), mode);
  } catch { /* a browser that refuses storage still gets a working list */ }
}

/** All three, in the order the buttons sit in. */
export const ALL_LIST_MODES: ListMode[] = ['table', 'kanban', 'ipropy'];

/**
 * Which views the admin has left switched on, in Admin → List Views.
 *
 * `null` — no setting saved, or a malformed one — means all three, so a list
 * always has somewhere to go. The same reason the last view on cannot be
 * switched off: a module with no view is a blank page.
 */
export function enabledListModes(setting: Partial<Record<ListMode, boolean>> | null | undefined): ListMode[] {
  const on = ALL_LIST_MODES.filter((mode) => setting?.[mode] !== false);
  return on.length ? on : ALL_LIST_MODES;
}

/**
 * The one place the sources are ranked, so the list and its test cannot
 * disagree about what "default" means.
 *
 * A view the admin has switched off is not a choice anybody can still hold —
 * somebody who chose the board last week, on a CRM where the board is now off,
 * gets the first view that is on rather than a button that is not there.
 */
export function resolveListMode(
  chosen: ListMode | null,
  viewMode: string | null | undefined,
  allowed: ListMode[] = ALL_LIST_MODES,
): ListMode {
  const on = allowed.length ? allowed : ALL_LIST_MODES;
  const first = on.includes(DEFAULT_LIST_MODE) ? DEFAULT_LIST_MODE : on[0]!;
  if (chosen && on.includes(chosen)) return chosen;
  if (chosen) return first;
  // A saved view naming a board or a desk means it; a view that says `table`
  // is almost always one that predates the desk and simply never chose.
  if ((viewMode === 'kanban' || viewMode === 'ipropy') && on.includes(viewMode)) return viewMode;
  return first;
}
