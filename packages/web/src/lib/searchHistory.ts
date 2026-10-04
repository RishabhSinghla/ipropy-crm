/**
 * The last few things somebody searched for.
 *
 * **4 October 2026, the owner, with a design of the search panel he wants:**
 * *"we can search everything, the result shown in list. by source of result and
 * last search also shown in below … we want word's all dynamic features in this
 * search, means most advance label search engine of our crm."* His picture has a
 * **Last Search** row of chips, each with a small × on it.
 *
 * Kept in this browser rather than on the server, for the same reason the split
 * view's width is: what a rep typed ten minutes ago is nobody else's business,
 * it changes several times an hour, and a round trip to recall it is slow at
 * exactly the moment somebody is in a hurry.
 *
 * Every function here is pure except for the one line that touches storage, so
 * a `node` test can prove the rules without a browser.
 */

const KEY = 'ipropy.search.recent';

/** Five. Enough to catch the search you just closed; short enough to read in one glance. */
export const RECENT_LIMIT = 5;

/**
 * Put a term at the front of the list.
 *
 * **The same search typed twice is one entry**, matched without regard to case
 * or surrounding spaces — otherwise searching "sharma" after "Sharma " fills the
 * row with the same word four times and the other four searches fall off the
 * end. The newest spelling wins, because that is the one somebody just chose.
 */
export function withRecent(existing: string[], term: string): string[] {
  const clean = term.trim();
  if (!clean) return existing;
  const rest = existing.filter((item) => item.trim().toLowerCase() !== clean.toLowerCase());
  return [clean, ...rest].slice(0, RECENT_LIMIT);
}

/** Take one off, matched the same forgiving way it was added. */
export function withoutRecent(existing: string[], term: string): string[] {
  return existing.filter((item) => item.trim().toLowerCase() !== term.trim().toLowerCase());
}

/**
 * What this browser remembers.
 *
 * Storage can throw — a private window, blocked site data, a quota — and it can
 * hold something that is not a list of strings, because anything may write to a
 * key. Either way the answer is an empty list and not an exception: a search box
 * that cannot open because its history is unreadable is a far worse fault than
 * one with no history.
 */
export function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Write it back, and carry on if the browser will not have it. */
export function writeRecent(terms: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(terms.slice(0, RECENT_LIMIT)));
  } catch {
    /* A remembered search is a convenience; losing it must never break the box. */
  }
}
