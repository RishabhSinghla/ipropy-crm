/**
 * Picking the call deck up and putting it somewhere else.
 *
 * **24 September 2026, the owner:** *"I want this call panel to be movable …
 * so I can pick it up and move anywhere but by default it should be there in
 * header only."* So it starts docked in the record's header and stays there
 * until somebody drags it, and where they leave it is remembered.
 *
 * Remembered in this browser rather than on the server, like the split view's
 * own width and the list mode: it is a working habit, it is nobody else's
 * business, and a round trip to ask where somebody likes their call panel is
 * slow at exactly the wrong moment.
 *
 * localStorage throws outright in a locked-down browser or a private window,
 * so every read and write is guarded and the deck falls back to its dock.
 */
export interface DeckSpot {
  left: number;
  top: number;
}

const KEY = 'ipropy.callDeckSpot';

export function loadDeckSpot(): DeckSpot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DeckSpot>;
    return typeof value?.left === 'number' && typeof value?.top === 'number'
      ? { left: value.left, top: value.top }
      : null;
  } catch {
    return null;
  }
}

export function saveDeckSpot(spot: DeckSpot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(spot));
  } catch { /* a browser that refuses storage still gets a working deck */ }
}

export function forgetDeckSpot(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to clear */ }
}

/**
 * Keep the deck on the screen.
 *
 * Dropped past an edge — or left there and the window then made smaller — it
 * would be unreachable, with a live call inside it and no way to end it. The
 * margin leaves enough of it showing to grab.
 */
export function keepOnScreen(
  spot: DeckSpot,
  deck: { width: number; height: number },
  screen: { width: number; height: number },
): DeckSpot {
  const margin = 24;
  return {
    left: Math.min(Math.max(spot.left, margin - deck.width + 80), screen.width - margin - 80),
    top: Math.min(Math.max(spot.top, margin), screen.height - margin - 40),
  };
}
