import { describe, expect, it } from 'vitest';
import type { HeaderTab } from '@ipropy/shared';
import { arrangeHeaderTabs } from '../src/lib/headerTabs';
import { waDigits } from '../src/lib/whatsapp';

describe('arrangeHeaderTabs', () => {
  it('ships Dashboard, the modules and Site visit when nothing is arranged', () => {
    const tabs = arrangeHeaderTabs(null, ['leads', 'properties']);
    expect(tabs.map((t) => t.kind)).toEqual(['dashboard', 'module', 'module', 'capture']);
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
    expect(tabs.map((t) => t.kind)).toEqual(['dashboard', 'module']);
  });

  it('still appends a module the arrangement does not name', () => {
    const tabs = arrangeHeaderTabs([{ kind: 'dashboard' }], ['leads']);
    expect(tabs.some((t) => t.kind === 'module' && t.value === 'leads')).toBe(true);
  });
});

describe('waDigits', () => {
  it('keeps digits only, so a formatted number and a raw one agree', () => {
    expect(waDigits('+91 98765 43210')).toBe('919876543210');
    expect(waDigits('(020) 4000-1234')).toBe('02040001234');
    expect(waDigits('')).toBe('');
  });
});
