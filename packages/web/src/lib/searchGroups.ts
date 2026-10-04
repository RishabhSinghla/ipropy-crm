/**
 * Search answers, grouped by where they came from.
 *
 * **4 October 2026, the owner:** *"the result shown in list. by source of
 * result."* His design shows **Peoples (8)** and **Listings (8)** as headings
 * with the hits under each, and a count on the heading.
 *
 * Pure, and separate from the panel that draws it, because the two rules below
 * are both things a browser would only show by accident:
 *
 * * **The server's order is kept.** A group appears where its first hit
 *   appeared, and the hits inside it stay in the order they arrived — which is
 *   most recently touched first. Sorting the groups by size would put the
 *   module somebody was not looking for at the top whenever it happened to
 *   have more matches.
 * * **A record somebody cannot open is grouped with its own kind**, never
 *   dropped and never collected into an "other" bucket. It is the answer to
 *   *"does anybody already have this number"*, so it has to sit beside the ones
 *   that can be opened.
 */
import type { SearchHit } from './api';

export interface SearchGroup {
  module: string;
  label: string;
  hits: SearchHit[];
}

export function groupHits(hits: SearchHit[]): SearchGroup[] {
  const order: string[] = [];
  const byModule = new Map<string, SearchGroup>();
  for (const hit of hits) {
    let group = byModule.get(hit.module);
    if (!group) {
      group = { module: hit.module, label: hit.moduleLabel || hit.module, hits: [] };
      byModule.set(hit.module, group);
      order.push(hit.module);
    }
    group.hits.push(hit);
  }
  return order.map((module) => byModule.get(module)!);
}

/**
 * Every hit as one flat list, in the order the panel draws them.
 *
 * This is what ↑ and ↓ walk. Deriving it from the groups rather than from the
 * server's own array is the point: the two would disagree the moment grouping
 * reordered anything, and then the arrow keys would highlight one row and Enter
 * would open another.
 */
export function flattenGroups(groups: SearchGroup[]): SearchHit[] {
  return groups.flatMap((group) => group.hits);
}

/**
 * Where the highlight lands after a key press.
 *
 * It **wraps**, so ↓ at the bottom returns to the top: a list of five answers is
 * read by holding one key, and stopping dead at the end makes somebody look for
 * the mouse. Nothing selected and ↑ pressed starts at the last row, which is how
 * every menu on every platform behaves.
 */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}
