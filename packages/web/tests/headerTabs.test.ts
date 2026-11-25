import { describe, expect, it } from 'vitest';
import type { HeaderTab } from '@ipropy/shared';
import { arrangeHeaderTabs } from '../src/lib/headerTabs';

describe('arrangeHeaderTabs', () => {
  it('ships Dashboard, the modules and Site visit when nothing is arranged', () => {
    const tabs = arrangeHeaderTabs(null, ['leads', 'properties']);
    expect(tabs.map((t) => t.kind)).toEqual(['dashboard', 'module', 'module', 'calls', 'capture']);
  });

  /*
    Chats was a fixed tab here until 19 September 2026, when the owner asked
    for it to go. An arrangement saved while it existed still names it, and a
    saved `chats` entry must not resurrect the tab — the kind no longer exists,
    so anything unrecognised is dropped rather than rendered as a dead link.
  */
  it('drops a Chats entry left in an arrangement saved before it was removed', () => {
    const saved = [
      { kind: 'dashboard' },
      { kind: 'chats', label: 'Messages' },
      { kind: 'module', value: 'leads' },
    ] as unknown as HeaderTab[];
    const tabs = arrangeHeaderTabs(saved, ['leads']);
    expect(tabs.map((t) => t.kind)).toEqual(['dashboard', 'module', 'calls']);
  });

  it('appends Calls to an arrangement saved before that page existed too', () => {
    const saved = [{ kind: 'dashboard' }] as HeaderTab[];
    expect(arrangeHeaderTabs(saved, []).some((t) => t.kind === 'calls')).toBe(true);
  });

  /*
    Reports was folded into the WhatsApp page on 20 September 2026, and
    production's saved arrangement still names it. A kind this build no longer
    places must be dropped rather than rendered — a tab that goes nowhere is
    worse than no tab, which is the lesson `chats` left behind.
  */
  it('drops Reports, which is a tab inside WhatsApp now', () => {
    const saved = [{ kind: 'dashboard' }, { kind: 'reports' }] as HeaderTab[];
    const tabs = arrangeHeaderTabs(saved, []);
    expect(tabs.some((t) => t.kind === 'reports')).toBe(false);
  });

  it('still appends a module the arrangement does not name', () => {
    const tabs = arrangeHeaderTabs([{ kind: 'dashboard' }], ['leads']);
    expect(tabs.some((t) => t.kind === 'module' && t.value === 'leads')).toBe(true);
  });
});
