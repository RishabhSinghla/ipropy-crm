import { describe, expect, it } from 'vitest';
import { allSplitTabs, heroFieldNames, queueLinePreview, splitTabsFor } from '../src/lib/splitViewLayout';

describe('splitTabsFor', () => {
  it('shows every tab in the shipped order until somebody chooses', () => {
    expect(splitTabsFor('leads', undefined).map((tab) => tab.key))
      .toEqual(['timeline', 'matching', 'files', 'calls', 'whatsapp']);
  });

  it('keeps the admin’s order and names, and hides what was left out', () => {
    const tabs = splitTabsFor('leads', [
      { key: 'calls', label: 'Phone' },
      { key: 'timeline', label: '' },
    ]);
    expect(tabs).toEqual([
      { key: 'calls', label: 'Phone' },
      // A blank name falls back to the shipped one rather than an empty tab.
      { key: 'timeline', label: 'Timeline' },
    ]);
  });

  it('drops the overview a saved list may still name — it lives in the right pane now', () => {
    expect(splitTabsFor('leads', [{ key: 'overview', label: 'Overview' }, { key: 'files', label: 'Files' }]))
      .toEqual([{ key: 'files', label: 'Files' }]);
  });

  it('drops tabs this build cannot draw, duplicates, and matching where there is none', () => {
    const tabs = splitTabsFor('other', [
      { key: 'rel:projects', label: 'Projects' },
      { key: 'matching', label: 'Matching' },
      { key: 'files', label: 'Docs' },
      { key: 'files', label: 'Again' },
    ]);
    expect(tabs).toEqual([{ key: 'files', label: 'Docs' }]);
  });

  it('never leaves a record with no tabs', () => {
    expect(splitTabsFor('properties', [{ key: 'nonsense', label: 'x' }])).toEqual(allSplitTabs('properties'));
  });

  it('names matching after the other module', () => {
    expect(allSplitTabs('properties').find((tab) => tab.key === 'matching')?.label).toBe('Matching leads');
  });
});

describe('heroFieldNames', () => {
  it('is the chase date then the stage until somebody chooses', () => {
    expect(heroFieldNames(undefined, 'next_follow_up', 'status')).toEqual(['next_follow_up', 'status']);
  });

  it('is exactly the saved list once saved, even an empty one', () => {
    expect(heroFieldNames(['budget', 'status', 'budget'], 'next_follow_up', 'status')).toEqual(['budget', 'status']);
    expect(heroFieldNames([], 'next_follow_up', 'status')).toEqual([]);
  });
});

describe('queueLinePreview', () => {
  it('joins the facts the way the queue card does, skipping blanks and dashes', () => {
    expect(queueLinePreview(['4 BHK', '', '—', 'Builder Floor', null, 'Greenfields Colony']))
      .toBe('4 BHK, Builder Floor, Greenfields Colony');
  });
});
