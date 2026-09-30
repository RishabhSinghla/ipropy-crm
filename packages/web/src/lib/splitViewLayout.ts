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
    { key: 'timeline', label: 'Timeline' },
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
    chosen.push({ key: known.key, label: item.label?.trim() || known.label });
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
