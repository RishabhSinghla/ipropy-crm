import { describe, expect, it } from 'vitest';
import { ALL_LIST_MODES, enabledListModes, resolveListMode } from '../src/lib/listMode';

/**
 * Which list views the team may use, and what a list opens as.
 *
 * The one thing these tests exist to prevent is a blank page: an admin
 * switching everything off, a settings row arriving malformed, or somebody
 * whose remembered choice is a view that no longer exists. Every one of those
 * has to land on a view that is actually on.
 */
describe('which list views are on', () => {
  it('is all three when nothing has been saved', () => {
    expect(enabledListModes(null)).toEqual(ALL_LIST_MODES);
    expect(enabledListModes(undefined)).toEqual(ALL_LIST_MODES);
  });

  it('drops the ones switched off', () => {
    expect(enabledListModes({ table: true, kanban: false, ipropy: true })).toEqual(['table', 'ipropy']);
  });

  it('refuses to leave a list with no view at all', () => {
    expect(enabledListModes({ table: false, kanban: false, ipropy: false })).toEqual(ALL_LIST_MODES);
  });
});

describe('what a list opens as', () => {
  it('honours what this person chose', () => {
    expect(resolveListMode('table', null)).toBe('table');
  });

  it('falls back when their choice has since been switched off', () => {
    expect(resolveListMode('kanban', null, ['table', 'ipropy'])).toBe('ipropy');
  });

  it('honours a saved view that names a board, unless the board is off', () => {
    expect(resolveListMode(null, 'kanban')).toBe('kanban');
    expect(resolveListMode(null, 'kanban', ['table', 'ipropy'])).toBe('ipropy');
  });

  it('opens the split view by default, and the first view on when it is off', () => {
    expect(resolveListMode(null, 'table')).toBe('ipropy');
    expect(resolveListMode(null, 'table', ['table', 'kanban'])).toBe('table');
  });
});
