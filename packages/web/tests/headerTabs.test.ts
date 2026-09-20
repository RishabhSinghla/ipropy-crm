import { describe, expect, it } from 'vitest';
import type { HeaderTab } from '@ipropy/shared';
import { arrangeHeaderTabs } from '../src/lib/headerTabs';
import { waDigits } from '../src/lib/whatsapp';

describe('arrangeHeaderTabs', () => {
  it('ships Dashboard, the modules and Site visit when nothing is arranged', () => {
    const tabs = arrangeHeaderTabs(null, ['leads', 'properties']);
    expect(tabs.map((t) => t.kind)).toEqual(['dashboard', 'module', 'module', 'whatsapp', 'capture']);
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
    expect(tabs.map((t) => t.kind)).toEqual(['dashboard', 'module', 'whatsapp']);
  });

  /*
    The other half of the same rule, and the reason it is written down: an
    arrangement saved before WhatsApp existed — which is every arrangement on
    production — cannot have meant to leave it out, so it is appended rather
    than being the one screen nobody can reach. That is exactly what happened
    to Chats.
  */
  it('appends WhatsApp to an arrangement saved before the page existed', () => {
    const saved = [{ kind: 'dashboard' }, { kind: 'module', value: 'leads' }] as HeaderTab[];
    expect(arrangeHeaderTabs(saved, ['leads']).some((t) => t.kind === 'whatsapp')).toBe(true);
  });

  it('does not add a second WhatsApp when the arrangement already names it', () => {
    const saved = [{ kind: 'whatsapp' }, { kind: 'dashboard' }] as HeaderTab[];
    const tabs = arrangeHeaderTabs(saved, []);
    expect(tabs.filter((t) => t.kind === 'whatsapp')).toHaveLength(1);
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

describe('waDigits', () => {
  it('keeps digits only, so a formatted number and a raw one agree', () => {
    expect(waDigits('+91 98765 43210')).toBe('919876543210');
    expect(waDigits('(020) 4000-1234')).toBe('02040001234');
    expect(waDigits('')).toBe('');
  });
});
