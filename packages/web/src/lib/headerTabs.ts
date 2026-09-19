import type { HeaderTab } from '@ipropy/shared';

const KINDS = new Set<HeaderTab['kind']>(['dashboard', 'capture', 'module', 'link']);

/**
 * The header's tabs: the admin's arrangement, with nothing orphaned.
 *
 * Pure and exported for its test. The bug it pins had no other way to be
 * caught: a fresh database has no arrangement, so every local run took the
 * shipped default and Chats was missing only on production.
 */
export function arrangeHeaderTabs(arranged: HeaderTab[] | null, moduleNames: string[]): HeaderTab[] {
  // No arrangement yet: the shipped order. Dashboard first, the modules in
  // their own sequence, Site visit last.
  if (!arranged?.length) {
    return [
      { kind: 'dashboard' as const },
      ...moduleNames.map((name) => ({ kind: 'module' as const, value: name })),
      { kind: 'capture' as const },
    ];
  }
  /*
    A kind this build no longer has is dropped, not rendered. Chats was a fixed
    tab until 19 September 2026 and production's saved arrangement still names
    it; keeping it would put a tab on the header that goes nowhere, which is
    worse than the tab simply being gone.
  */
  const placed: HeaderTab[] = arranged
    .filter((t) => KINDS.has(t.kind))
    .map((t) => ({ ...t }));
  const used = new Set(placed.filter((t) => t.kind === 'module').map((t) => t.value));
  for (const name of moduleNames) {
    if (!used.has(name)) placed.push({ kind: 'module' as const, value: name });
  }
  /*
    Anything fixed added to this header later needs a line here: an
    arrangement saved before a page existed cannot have meant to leave it
    out. Chats had one until 19 September 2026, when the header entry was
    removed on the owner's instruction — its page is still reached from the
    WhatsApp icon beside a number.
  */
  return placed;
}
