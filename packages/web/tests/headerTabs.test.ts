import { describe, expect, it } from 'vitest';
import type { HeaderTab } from '@ipropy/shared';
import { arrangeHeaderTabs } from '../src/lib/headerTabs';
import { waDigits } from '../src/lib/whatsapp';

describe('arrangeHeaderTabs', () => {
  it('ships Dashboard, the modules, Chats and Site visit when nothing is arranged', () => {
    const tabs = arrangeHeaderTabs(null, ['leads', 'properties']);
    expect(tabs.map((t) => t.kind)).toEqual(['dashboard', 'module', 'module', 'chats', 'capture']);
  });

  /*
    The regression that took Chats off production: an arrangement saved before
    the page existed cannot name it, and the old code only appended missing
    modules. Locally there is no arrangement, so nothing failed.
  */
  it('appends Chats to an arrangement saved before it existed', () => {
    const saved: HeaderTab[] = [
      { kind: 'dashboard' },
      { kind: 'module', value: 'leads' },
      { kind: 'module', value: 'properties' },
    ];
    const tabs = arrangeHeaderTabs(saved, ['leads', 'properties']);
    expect(tabs.filter((t) => t.kind === 'chats')).toHaveLength(1);
  });

  it('leaves a placed Chats where the admin put it, and does not double it', () => {
    const saved: HeaderTab[] = [
      { kind: 'chats', label: 'Messages' },
      { kind: 'dashboard' },
    ];
    const tabs = arrangeHeaderTabs(saved, []);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toEqual({ kind: 'chats', label: 'Messages' });
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
