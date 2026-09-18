/**
 * Which way a list opens: the iPROPY desk, the table, or the board.
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

/**
 * The one place the three sources are ranked, so the list and its test cannot
 * disagree about what "default" means.
 */
export function resolveListMode(
  chosen: ListMode | null,
  viewMode: string | null | undefined,
): ListMode {
  if (chosen) return chosen;
  // A saved view naming a board or a desk means it; a view that says `table`
  // is almost always one that predates the desk and simply never chose.
  if (viewMode === 'kanban' || viewMode === 'ipropy') return viewMode;
  return DEFAULT_LIST_MODE;
}
