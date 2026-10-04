/**
 * The search panel's two decisions: how answers are grouped, and what this
 * browser remembers having been asked.
 *
 * Every rule here is one a rep would otherwise meet as "the search is odd": the
 * same word four times in the last-search row, the arrow keys highlighting one
 * row while Enter opens another, a module jumping to the top because it happened
 * to match more.
 */
import { describe, expect, it } from 'vitest';
import { flattenGroups, groupHits, moveHighlight } from '../src/lib/searchGroups';
import { RECENT_LIMIT, withRecent, withoutRecent } from '../src/lib/searchHistory';
import type { SearchHit } from '../src/lib/api';

const hit = (id: string, module: string, label: string): SearchHit => ({
  id, module, moduleLabel: module === 'leads' ? 'Contacts' : 'Inventories', label,
});

describe('grouping the answers by where they came from', () => {
  it('keeps the order the server sent, for the groups and inside them', () => {
    const groups = groupHits([
      hit('1', 'properties', 'B-110'),
      hit('2', 'leads', 'Riya'),
      hit('3', 'properties', 'B-112'),
      hit('4', 'leads', 'Rahul'),
    ]);
    // Inventories first because its first hit came first — not because it has
    // more. Sorting by size puts the module nobody asked for at the top.
    expect(groups.map((g) => g.module)).toEqual(['properties', 'leads']);
    expect(groups[0]!.hits.map((h) => h.label)).toEqual(['B-110', 'B-112']);
    expect(groups[0]!.label).toBe('Inventories');
  });

  it('counts each group by what is in it', () => {
    const groups = groupHits([hit('1', 'leads', 'a'), hit('2', 'leads', 'b'), hit('3', 'properties', 'c')]);
    expect(groups.map((g) => g.hits.length)).toEqual([2, 1]);
  });

  it('keeps a record somebody cannot open beside its own kind', () => {
    const locked: SearchHit = { ...hit('9', 'leads', 'Somebody'), restricted: true };
    const groups = groupHits([hit('1', 'leads', 'Riya'), locked]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hits).toHaveLength(2);
  });

  it('flattens in the order the panel draws, so ↑↓ and ↵ cannot disagree', () => {
    const groups = groupHits([hit('1', 'properties', 'B'), hit('2', 'leads', 'R'), hit('3', 'properties', 'C')]);
    expect(flattenGroups(groups).map((h) => h.id)).toEqual(['1', '3', '2']);
  });

  it('answers nothing for nothing', () => {
    expect(groupHits([])).toEqual([]);
    expect(flattenGroups([])).toEqual([]);
  });
});

describe('where the highlight lands', () => {
  it('wraps both ways, so one held key reads the whole list', () => {
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });

  it('starts at the top going down and at the bottom going up', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
  });

  it('highlights nothing when there is nothing', () => {
    expect(moveHighlight(-1, 1, 0)).toBe(-1);
  });
});

describe('the last few searches', () => {
  it('puts the newest first', () => {
    expect(withRecent(['sharma'], 'baner')).toEqual(['baner', 'sharma']);
  });

  it('counts the same search once however it was typed', () => {
    // Without this the row fills with one word and the other four fall off.
    expect(withRecent(['Sharma'], 'sharma ')).toEqual(['sharma']);
  });

  it('keeps only the last five', () => {
    let list: string[] = [];
    for (const term of ['a', 'b', 'c', 'd', 'e', 'f']) list = withRecent(list, term);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toBe('f');
    expect(list).not.toContain('a');
  });

  it('remembers nothing for an empty box', () => {
    expect(withRecent(['baner'], '   ')).toEqual(['baner']);
  });

  it('forgets one the same forgiving way it was added', () => {
    expect(withoutRecent(['Baner', 'sharma'], ' baner ')).toEqual(['sharma']);
  });
});
