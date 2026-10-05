import { describe, expect, it } from 'vitest';
import { allSplitTabs, heroFieldNames, queueLinePreview, splitTabsFor } from '../src/lib/splitViewLayout';

describe('splitTabsFor', () => {
  it('shows every tab in the shipped order until somebody chooses', () => {
    /*
      `builders` joined on 5 October 2026 — the owner's Builder's Inventory,
      *"in Menu bar same as Matching Inventory"*, which is why it sits straight
      after the tab he compared it to.
    */
    expect(splitTabsFor('leads', undefined).map((tab) => tab.key))
      .toEqual(['timeline', 'matching', 'builders', 'files', 'calls', 'whatsapp']);
  });

  it('gives Builder Floors the same tab, showing its own locality instead', () => {
    /*
      One table, two questions. On a contact it is what fits them; on a house it
      is every other house in that colony — *"we want create multiple unit of
      multiple builder under in a locality"*. Naming it for what it shows rather
      than for the module it reads is what lets one component serve both.
    */
    const tabs = splitTabsFor('builder_floors', undefined);
    expect(tabs.map((tab) => tab.key)).toContain('builders');
    expect(tabs.find((tab) => tab.key === 'builders')?.label).toBe("Builder's Floor");
    // And it has no Matching tab: matching is Contacts-to-Inventories.
    expect(tabs.map((tab) => tab.key)).not.toContain('matching');
  });

  it('keeps the admin’s order and names, and hides what was left out', () => {
    const tabs = splitTabsFor('leads', [
      { key: 'calls', label: 'Phone' },
      { key: 'timeline', label: '' },
    ]);
    expect(tabs).toEqual([
      { key: 'calls', label: 'Phone' },
      // A blank name falls back to the shipped one rather than an empty tab.
      { key: 'timeline', label: 'Activity' },
    ]);
  });

  it('reads the old shipped name "Timeline" as the new one, "Activity"', () => {
    // The Layout Designer saves every tab's name, renamed or not, so a layout
    // saved before 2 October 2026 says "Timeline" without anybody choosing it.
    expect(splitTabsFor('leads', [{ key: 'timeline', label: 'Timeline' }]))
      .toEqual([{ key: 'timeline', label: 'Activity' }]);
    expect(splitTabsFor('leads', [{ key: 'timeline', label: 'History' }]))
      .toEqual([{ key: 'timeline', label: 'History' }]);
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

describe('rightPaneRowNames', () => {
  it('unsaved, shows what the pane always has: owner, header facts, call log, then the number', async () => {
    const { rightPaneRowNames, OWNER_ROW, CALL_LOG_ROW } = await import('../src/lib/splitViewLayout');
    expect(rightPaneRowNames(undefined, ['next_followup_at', 'status'], 'owner_id', 'mobile', new Set()))
      .toEqual([OWNER_ROW, 'next_followup_at', 'status', CALL_LOG_ROW, 'mobile']);
  });
  it('leaves the number out when a section already holds it', async () => {
    const { rightPaneRowNames } = await import('../src/lib/splitViewLayout');
    expect(rightPaneRowNames(undefined, [], 'owner_id', 'mobile', new Set(['mobile']))).not.toContain('mobile');
  });
  it('saved, is exactly the admin list — owner and call log can move or go', async () => {
    const { rightPaneRowNames, CALL_LOG_ROW } = await import('../src/lib/splitViewLayout');
    expect(rightPaneRowNames([CALL_LOG_ROW, 'status', 'status'], ['next_followup_at'], 'owner_id', 'mobile', new Set()))
      .toEqual([CALL_LOG_ROW, 'status']);
    expect(rightPaneRowNames([], ['status'], 'owner_id', 'mobile', new Set())).toEqual([]);
  });
});
