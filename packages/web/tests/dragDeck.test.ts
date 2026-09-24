import { describe, expect, it } from 'vitest';
import { keepOnScreen } from '../src/lib/dragDeck';

/**
 * Where the call panel is allowed to end up.
 *
 * The one thing that must not happen: a deck dropped past an edge — or left
 * near one and the window then made smaller — sitting off the screen with a
 * live call inside it and no way to reach End. So enough of it always stays
 * in view to grab.
 */
const DECK = { width: 304, height: 80 };
const SCREEN = { width: 1440, height: 850 };

describe('keeping the call panel reachable', () => {
  it('leaves a sensible drop alone', () => {
    expect(keepOnScreen({ left: 600, top: 400 }, DECK, SCREEN)).toEqual({ left: 600, top: 400 });
  });

  it('pulls it back when dropped off the right', () => {
    const { left } = keepOnScreen({ left: 5000, top: 400 }, DECK, SCREEN);
    expect(left).toBeLessThan(SCREEN.width);
    expect(left + DECK.width).toBeGreaterThan(0);
  });

  it('pulls it back when dropped off the left', () => {
    const { left } = keepOnScreen({ left: -5000, top: 400 }, DECK, SCREEN);
    // Part of it stays on screen, which is all a person needs to grab it.
    expect(left + DECK.width).toBeGreaterThan(0);
  });

  it('never lets it go above the top, where the browser chrome would eat it', () => {
    expect(keepOnScreen({ left: 600, top: -400 }, DECK, SCREEN).top).toBeGreaterThan(0);
  });

  it('pulls it back up when the window shrinks under it', () => {
    const small = { width: 800, height: 400 };
    const { left, top } = keepOnScreen({ left: 1300, top: 800 }, DECK, small);
    expect(top).toBeLessThan(small.height);
    expect(left).toBeLessThan(small.width);
  });
});
