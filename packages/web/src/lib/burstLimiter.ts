/**
 * One refresh per module per few seconds, however many edits arrive.
 *
 * 11 October 2026: the CRM was slow for the whole team at once. The server
 * tells every open screen "something in Contacts changed" after every edit,
 * and each screen answered by re-asking for its lists, counts, filters and
 * dashboards. Twelve people editing is dozens of such messages a minute, and
 * every one multiplied by twelve screens — on a half-CPU server.
 *
 * So the first message in a quiet period refreshes at once (an edit still shows
 * up immediately), and anything arriving during the next few seconds is folded
 * into a single refresh when that period ends. Nothing is dropped: the last
 * word still gets said, it is just said once.
 */
export type RefreshModule = (module: string | undefined, recordId: string | undefined) => void;

interface Quiet {
  /** Edits seen since the last refresh, by record id (undefined when none was named). */
  waiting: Set<string | undefined>;
  timer: ReturnType<typeof setTimeout>;
}

export function limitBursts(refresh: RefreshModule, windowMs: number): (module?: string, recordId?: string) => void {
  const byModule = new Map<string, Quiet>();

  const settle = (key: string, module: string | undefined): void => {
    const state = byModule.get(key);
    if (!state) return;
    if (state.waiting.size === 0) {
      byModule.delete(key);
      return;
    }
    // One record named: refresh that record too. Several: refresh the module only.
    const ids = [...state.waiting];
    state.waiting.clear();
    refresh(module, ids.length === 1 ? ids[0] : undefined);
    // The refresh starts another quiet period, so a steady stream is one per window.
    state.timer = setTimeout(() => settle(key, module), windowMs);
  };

  return (module, recordId) => {
    const key = module ?? '*';
    const state = byModule.get(key);
    if (state) {
      state.waiting.add(recordId);
      return;
    }
    refresh(module, recordId);
    byModule.set(key, { waiting: new Set(), timer: setTimeout(() => settle(key, module), windowMs) });
  };
}
