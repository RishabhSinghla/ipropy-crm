import type { HeaderTab } from '@ipropy/shared';

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
      { kind: 'chats' as const },
      { kind: 'capture' as const },
    ];
  }
  const placed: HeaderTab[] = arranged.map((t) => ({ ...t }));
  const used = new Set(placed.filter((t) => t.kind === 'module').map((t) => t.value));
  for (const name of moduleNames) {
    if (!used.has(name)) placed.push({ kind: 'module' as const, value: name });
  }
  /*
    A fixed page shipped after the arrangement was saved is in the same
    position as a module created after it: nobody chose to leave it out,
    because it did not exist to leave out.
  */
  if (!placed.some((t) => t.kind === 'chats')) placed.push({ kind: 'chats' as const });
  return placed;
}
