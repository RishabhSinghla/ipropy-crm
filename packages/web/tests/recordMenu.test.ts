/**
 * The record's menu bar: the order, the spill into "More", and the drag.
 *
 * **2 October 2026, the owner:** *"Please Make Menu tab Drag and drop in menu
 * bar … and if button too much, then 'More hamburger' will be shown."*
 *
 * Dragging is the one interaction nobody can check by reading — the browser
 * hands you two indexes and the rest is arithmetic that is easy to get subtly
 * wrong. So the arithmetic is pure and lives here.
 */
import { describe, expect, it } from 'vitest';
import {
  arrangeRecordMenu, moveEntry, ON_THE_BAR, splitMenu, activityKindOf,
  type MenuKey,
} from '../src/lib/recordMenu';

const ALL: MenuKey[] = ['timeline', 'matching', 'files', 'calls', 'whatsapp', 'comment', 'message', 'audit'];

describe('what the bar offers', () => {
  it('keeps a saved arrangement in the order it was saved', () => {
    const saved: MenuKey[] = ['calls', 'comment', 'files'];
    expect(arrangeRecordMenu(ALL, saved).slice(0, 3)).toEqual(saved);
  });

  it('drops an entry this module no longer offers', () => {
    // Matching is leads and inventories only. A saved order naming it on a
    // module without it must not leave a button that goes nowhere.
    const order = arrangeRecordMenu(['comment', 'calls'], ['matching', 'comment', 'calls']);
    expect(order).not.toContain('matching');
    expect(order).toEqual(['comment', 'calls']);
  });

  it('appends an entry that is new since the arrangement was saved', () => {
    // The opposite trap, and the one that hides a feature: an order saved
    // before an entry existed cannot have meant to leave it out.
    const order = arrangeRecordMenu(ALL, ['calls']);
    expect(order[0]).toBe('calls');
    for (const key of ALL) expect(order).toContain(key);
  });

  it('answers the default order when nobody has arranged anything', () => {
    const order = arrangeRecordMenu(ALL, null);
    expect(order[0], 'a record should open on Comments').toBe('comment');
    expect(order).toHaveLength(ALL.length);
  });
});

describe('what spills into More', () => {
  it('puts five on the bar and the rest behind the hamburger', () => {
    const { bar, more } = splitMenu(arrangeRecordMenu(ALL, null));
    expect(bar).toHaveLength(ON_THE_BAR);
    expect(more).toHaveLength(ALL.length - ON_THE_BAR);
    expect([...bar, ...more]).toEqual(arrangeRecordMenu(ALL, null));
  });

  it('shows no More at all when everything fits', () => {
    const { bar, more } = splitMenu(['comment', 'calls']);
    expect(bar).toEqual(['comment', 'calls']);
    expect(more).toEqual([]);
  });
});

describe('dragging one entry to another place', () => {
  it('moves it, and moves everything else up or down to suit', () => {
    expect(moveEntry(['a', 'b', 'c', 'd'] as MenuKey[], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveEntry(['a', 'b', 'c', 'd'] as MenuKey[], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when the drop lands where it started, or outside the list', () => {
    const order = ['a', 'b', 'c'] as MenuKey[];
    expect(moveEntry(order, 1, 1)).toBe(order);
    expect(moveEntry(order, -1, 1)).toBe(order);
    expect(moveEntry(order, 1, 9)).toBe(order);
  });

  it('can drag something out of More and on to the bar', () => {
    // The whole point of the spill: a rep who uses Changes every day moves it
    // up, and something else takes its place behind the hamburger.
    const order = arrangeRecordMenu(ALL, null);
    const moved = moveEntry(order, order.indexOf('audit'), 0);
    expect(splitMenu(moved).bar).toContain('audit');
    expect(splitMenu(moved).bar).toHaveLength(ON_THE_BAR);
  });
});

describe('which entries are the stream, narrowed', () => {
  it('names the three that filter the timeline', () => {
    expect(activityKindOf('comment')).toBe('comment');
    expect(activityKindOf('message')).toBe('message');
    expect(activityKindOf('audit')).toBe('audit');
  });

  it('leaves the tabs that draw their own screen alone', () => {
    // Calls and Files used to appear twice — a tab, and a chip two rows below
    // it. They are tabs; nothing filters the stream to them any more.
    for (const key of ['timeline', 'matching', 'files', 'calls', 'whatsapp'] as MenuKey[]) {
      expect(activityKindOf(key)).toBeNull();
    }
  });
});
