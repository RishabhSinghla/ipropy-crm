/**
 * The split view's arrangement, read defensively.
 *
 * This setting decides what every record in the CRM shows, for everybody, so a
 * malformed row must fall back to the shipped defaults rather than to an empty
 * arrangement. An empty array is a decision — "show no fields" — and that is
 * not something a bad row should be able to cause.
 */
import { describe, expect, it } from 'vitest';
import { readSplitView } from '../src/core/settings/ui.js';

describe('the split view setting', () => {
  it('reads three ordered lists per module', () => {
    expect(readSplitView({
      leads: { queue: ['contact_type', 'unit_no'], header: ['mobile'], form: ['budget'] },
    })).toEqual({
      leads: { queue: ['contact_type', 'unit_no'], header: ['mobile'], form: ['budget'] },
    });
  });

  it('fills in a list that was not saved, rather than refusing the module', () => {
    // An admin who arranged only the queue has said nothing about the header,
    // and "nothing said" has to stay distinguishable from "nothing shown".
    expect(readSplitView({ leads: { queue: ['contact_type'] } }))
      .toEqual({ leads: { queue: ['contact_type'], header: [], form: [] } });
  });

  it('drops a module with nothing chosen anywhere', () => {
    expect(readSplitView({ leads: { queue: [], header: [], form: [] } })).toBeNull();
    expect(readSplitView({ leads: {} })).toBeNull();
  });

  it('is null for anything that is not an object of objects', () => {
    expect(readSplitView(null)).toBeNull();
    expect(readSplitView(['full_name'])).toBeNull();
    expect(readSplitView({ leads: ['full_name'] })).toBeNull();
    expect(readSplitView({ leads: 'full_name' })).toBeNull();
  });

  it('ignores entries that are not usable names, and keeps the rest', () => {
    expect(readSplitView({ leads: { queue: ['contact_type', 7, null, '  ', 'unit_no'] } }))
      .toEqual({ leads: { queue: ['contact_type', 'unit_no'], header: [], form: [] } });
  });
});

/**
 * Which list views are on.
 *
 * The one failure worth guarding: a row saying every view is off would leave
 * every module with no way to show a record. The screen refuses it and so does
 * this, because a settings row must not be able to cause a blank page.
 */
