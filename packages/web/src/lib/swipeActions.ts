/**
 * Gmail-style swipe actions on a list card: swipe right to call, swipe left to
 * WhatsApp. Written for the leads card list, deliberately not a general
 * gesture system.
 *
 * Three properties the gesture must have to feel intentional rather than
 * accidental, all learned from how mail apps solved the same problem:
 *
 * 1. **The row must travel with the finger** — no animation that lags the
 *    touch, because the drag *is* the feedback that something is happening.
 * 2. **The action must be armed, not fired, until the finger passes a
 *    threshold.** Past it the background locks to the action's colour and the
 *    icon grows — releasing then fires. Below it, releasing snaps home and
 *    nothing happens. A wandering scroll therefore never messages anybody.
 * 3. **A vertical move cancels the horizontal one.** The list scrolls
 *    vertically; the first few pixels of any swipe look identical to the
 *    start of a scroll. The dominant axis wins, once, at the first ~8px.
 *
 * A `pointer`/`setPointerCapture` implementation rather than touch events:
 * capture keeps the events flowing to the card even when the finger crosses
 * onto a neighbouring row, which is the classic way a swipe silently dies
 * mid-gesture.
 */
import { useCallback, useRef, useState } from 'react';

/** How far the card must travel before the action is armed. */
const ARM_PX = 72;

/** How far the dominant-axis decision is made within. */
const AXIS_LOCK_PX = 8;

/** Release travel that fires the action even without being armed first —
 * a fast, short flick is a gesture people make naturally. */
const FLICK_PX = 40;

export type SwipeSide = 'left' | 'right';

export interface SwipeHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

export interface SwipeState {
  /** How far the card is displaced, in px. Negative = swiped left. */
  dx: number;
  /** Which action is currently armed, if any. */
  armed: SwipeSide | null;
}

/**
 * `onSwipe` receives the side that fired. Callers supply their own action —
 * a `tel:` navigation, a `wa.me` window, whatever the record's numbers are.
 */
export function useSwipeActions(
  onSwipe: (side: SwipeSide) => void,
  enabled = true,
): { handlers: SwipeHandlers; state: SwipeState } {
  const [state, setState] = useState<SwipeState>({ dx: 0, armed: null });

  const origin = useRef<{ x: number; y: number; locked: 'x' | 'y' | null } | null>(null);
  // Accumulated travel while dragging, kept in a ref so the render only
  // happens on the state set, not every pointermove bookkeeping step.
  const travel = useRef(0);
  const armedAt = useRef<SwipeSide | null>(null);

  const clear = useCallback(() => {
    origin.current = null;
    travel.current = 0;
    armedAt.current = null;
    setState({ dx: 0, armed: null });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled || e.pointerType === 'mouse') return;
    // Nested swipeables would fight; the innermost row wins.
    e.stopPropagation();
    origin.current = { x: e.clientX, y: e.clientY, locked: null };
  }, [enabled]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const o = origin.current;
    if (!o) return;
    const dx = e.clientX - o.x;
    const dy = e.clientY - o.y;

    // First significant movement decides the axis; after that, movement on
    // the other axis never re-opens the decision mid-gesture.
    if (!o.locked) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      // Vertical (scroll) wins ties, because the list is vertical: a thumb
      // drifting down-left while scrolling should scroll, not message.
      o.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (o.locked === 'y') { origin.current = null; return; }
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }

    travel.current = dx;
    const armed: SwipeSide | null = dx >= ARM_PX ? 'right' : dx <= -ARM_PX ? 'left' : null;
    armedAt.current = armed;
    setState({ dx, armed });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const o = origin.current;
    if (!o) { setState({ dx: 0, armed: null }); return; }
    const dx = travel.current;
    const armed = armedAt.current ?? (dx >= FLICK_PX ? 'right' : dx <= -FLICK_PX ? 'left' : null);
    // Release with an armed action (or a committed flick) fires; anything
    // else springs home with no side effects.
    if (armed && Math.abs(dx) >= FLICK_PX) {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      origin.current = null;
      travel.current = 0;
      armedAt.current = null;
      // Fire before resetting the transform so the navigation happens while
      // the card is still visibly at the end of its travel.
      setState({ dx: 0, armed: null });
      onSwipe(armed);
      return;
    }
    clear();
  }, [clear, onSwipe]);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: clear,
    },
    state,
  };
}
