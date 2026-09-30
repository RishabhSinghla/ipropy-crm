/**
 * The split view's own layout choices, read the same way by the screen that
 * draws them and the Layout Designer that sets them.
 *
 * **29 September 2026, the owner:** *"I need a proper layout designer in admin
 * panel for split view … each and everything be properly customized and
 * working."* Several controls on the old designer changed nothing at all in
 * the split view — the tabs, the tab it opens on, the header's key fields —
 * because the split view drew its own fixed versions. This file is where both
 * sides now agree.
 *
 * **Every choice here is stored under a new key** (`splitTabs`, `heroFields`)
 * rather than reusing the old ones. Production's layouts already carry old
 * `tabs` and `headerFields` values saved for the parked full record page; had
 * the split view started obeying those, the day this shipped every rep's
 * screen would have changed with nobody having asked for it. A key nobody has
 * saved yet means "exactly what the split view showed before".
 *
 * Pure, so a `node` test can read it without the app's store.
 */

/*
  No `overview`: since 30 September 2026 the record's fields live in the
  right-hand pane under the call deck (the owner's prototype), so they are not
  a tab any more. A saved list that still names it simply drops it, the same
  way it drops anything else this build cannot draw.
*/
export type SplitTabKey = 'timeline' | 'matching' | 'files' | 'calls' | 'whatsapp';

export interface SplitTab {
  key: SplitTabKey;
  label: string;
}

/** Matching exists only between the two modules that can be matched. */
function hasMatching(moduleName: string): boolean {
  return moduleName === 'leads' || moduleName === 'properties';
}

/** Every tab the split view can draw for this module, in its shipped order and wording. */
export function allSplitTabs(moduleName: string): SplitTab[] {
  const tabs: SplitTab[] = [
    // "Activity" since 1 October 2026, the owner's word for it.
    { key: 'timeline', label: 'Activity' },
  ];
  if (hasMatching(moduleName)) {
    tabs.push({ key: 'matching', label: moduleName === 'leads' ? 'Matching inventory' : 'Matching leads' });
  }
  tabs.push(
    { key: 'files', label: 'Files' },
    { key: 'calls', label: 'Calls' },
    { key: 'whatsapp', label: 'WhatsApp' },
  );
  return tabs;
}

/**
 * A saved tab name, unless it is only the old shipped wording.
 *
 * The Layout Designer saves every tab's name, renamed or not, so a layout
 * saved before "Timeline" became "Activity" still says "Timeline" — which is
 * the old default, not a choice somebody made.
 */
function savedLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  return trimmed && trimmed !== 'Timeline' ? trimmed : undefined;
}

/**
 * The tabs a record shows, in the admin's order and wording. The first one is
 * the tab a record opens on.
 *
 * Anything saved that this build cannot draw is dropped, a tab left out is
 * hidden, and a list that would leave nothing falls back to the shipped tabs —
 * a record with no tabs at all has no way to show its own fields.
 */
export function splitTabsFor(
  moduleName: string,
  saved: { key: string; label?: string }[] | undefined,
): SplitTab[] {
  const all = allSplitTabs(moduleName);
  if (!saved?.length) return all;
  const chosen: SplitTab[] = [];
  for (const item of saved) {
    const known = all.find((tab) => tab.key === item.key);
    if (!known || chosen.some((tab) => tab.key === known.key)) continue;
    chosen.push({ key: known.key, label: savedLabel(item.label) || known.label });
  }
  return chosen.length ? chosen : all;
}

/**
 * Which fields sit as key facts in the record's header, in order.
 *
 * Unsaved, it is the chase date and the stage — what the header has shown
 * since the owner asked for it compact on 28 September. The call log always
 * follows them; it is not a field, so it is not in this list.
 */
export function heroFieldNames(
  saved: string[] | undefined,
  followUpField: string | undefined,
  statusField: string | undefined,
): string[] {
  if (saved) return [...new Set(saved)];
  return [followUpField, statusField].filter((name): name is string => Boolean(name));
}

/*
  The right pane's top rows, as the Layout Designer arranges them.

  The owner, 3 October 2026: *"mostly things towards very right pane of split
  that is that info pane I want fully customisable via layout designer only"*.
  Until then three rows were fixed in code — who owns the record first, the
  call log last, and the phone number added whenever no section held it — and
  only the facts between them could be chosen. Now every row is one entry in
  one ordered list (`rightPane`), and the two rows that are not fields have a
  name of their own. `@` cannot begin a field name (`quoteIdent` refuses it),
  so these can never collide with a real field.
*/
export const OWNER_ROW = '@owner';
export const CALL_LOG_ROW = '@call_log';

/**
 * The rows at the top of the right pane, in order.
 *
 * Saved, it is exactly the admin's list. Unsaved, it is what the pane has
 * always shown: the owner, the header facts, the call log, then the phone
 * number when no section below already holds it.
 */
export function rightPaneRowNames(
  saved: string[] | undefined,
  heroNames: string[],
  ownerField: string | undefined,
  phoneField: string | undefined,
  inSections: Set<string>,
): string[] {
  if (saved) return [...new Set(saved)];
  const rows = [OWNER_ROW, ...heroNames.filter((name) => name !== ownerField), CALL_LOG_ROW];
  if (phoneField && !inSections.has(phoneField) && !rows.includes(phoneField)) rows.push(phoneField);
  return rows;
}

/**
 * The words a queue card's middle line would show for one record, joined the
 * way the card joins them — so the designer's preview and the queue cannot
 * disagree about what a rep reads.
 */
export function queueLinePreview(values: (string | null | undefined)[]): string {
  return values
    .map((value) => (value ?? '').trim())
    .filter((value) => value && value !== '—')
    .join(', ');
}
