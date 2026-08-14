/**
 * Press and hold to peek at a record, the way iOS shows a message preview.
 *
 * On a phone the alternative to peeking is navigating: open the record, read
 * one number, press back, lose your scroll position, find your place again.
 * Doing that down a list of forty leads is most of what "using the CRM on the
 * phone" actually costs, and a preview removes the whole round trip.
 *
 * **Touch only, deliberately.** A mouse already has hover and a fast back
 * button, and binding long-press on desktop would mean a slow click on a row
 * fires a panel nobody asked for. `pointerType` is what separates them —
 * checked per event rather than sniffing the user agent, so a laptop with a
 * touchscreen behaves correctly for whichever input is actually in use.
 *
 * **About the haptic.** Android fires a short tick through the Vibration API.
 * iOS Safari has never implemented it and there is no web equivalent, so on an
 * iPhone the peek appears with no buzz. That is a platform limit, not a
 * missing feature here — `navigator.vibrate` is called through optional
 * chaining and simply does nothing there.
 */
import { useCallback, useRef } from 'react';

/**
 * How long a finger must rest before this counts as a press rather than a tap.
 *
 * Matched to the platform conventions either side: iOS peeks at roughly half a
 * second, Android's long-press is a little shorter. Below ~350ms an ordinary
 * slow tap starts firing it; above ~600ms it feels broken and people give up
 * before it triggers.
 */
const HOLD_MS = 450;

/**
 * How far a finger may drift and still be holding still.
 *
 * The important case is a list being scrolled: the first few pixels of a swipe
 * look exactly like the start of a press, so without this every flick down a
 * list of leads fires a preview. Ten pixels is below what a deliberate hold
 * wanders and well under what a scroll travels in 450ms.
 */
const MOVE_TOLERANCE_PX = 10;

/**
 * How long after a peek a click is still assumed to be part of the same
 * gesture. Generous enough to cover a slow lift, short enough that a later,
 * deliberate tap is never mistaken for one.
 */
const CLICK_GRACE_MS = 700;

export interface PressPreviewHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

/**
 * Returns props to spread onto whatever should be peekable.
 *
 * `onPeek` fires once per press. The caller decides what a peek shows and how
 * it is dismissed — this hook only recognises the gesture.
 */
export function usePressPreview(onPeek: () => void, enabled = true): PressPreviewHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  // When a press last fired, so the click that follows the finger lifting can
  // be told apart from a tap — without it, opening the peek also navigates.
  // A timestamp rather than a flag: a peek dismissed with Escape produces no
  // click at all, and a flag left standing would then swallow the *next*
  // genuine tap on the same row.
  const firedAt = useRef(0);

  /** The click a finger produces lands within a frame or two of the lift. */
  const justFired = useCallback(() => Date.now() - firedAt.current < CLICK_GRACE_MS, []);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled || e.pointerType === 'mouse') return;
    // Peekable things nest: a lookup value inside a card that is itself
    // peekable. Both timers would fire and the last one to land would win,
    // which is not a decision anybody made. The innermost wins instead —
    // pressing the unit's name means you want the unit, not the row it sits
    // in. This does not affect scrolling: pointer events do not drive it.
    e.stopPropagation();
    firedAt.current = 0;
    origin.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      firedAt.current = Date.now();
      // Android only; a no-op on iOS, which has no web haptic at all.
      navigator.vibrate?.(12);
      onPeek();
      clear();
    }, HOLD_MS);
  }, [enabled, onPeek, clear]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!origin.current) return;
    const dx = Math.abs(e.clientX - origin.current.x);
    const dy = Math.abs(e.clientY - origin.current.y);
    if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
  }, [clear]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    // Android raises its own long-press menu ("open in new tab", "copy link")
    // over the top of ours. Only suppressed once a peek has actually fired, so
    // a right-click on a laptop keeps working normally.
    if (justFired()) e.preventDefault();
  }, [justFired]);

  /**
   * Swallow the click a lifted finger still produces.
   *
   * Without this, holding a link both peeks *and* follows it: the preview
   * appears and the record page loads underneath it in the same gesture, which
   * is precisely the round trip the preview exists to avoid. Capture phase,
   * because the element's own onClick (React Router's `Link`, an inline-edit
   * trigger) must not have run yet — both bail on `defaultPrevented`.
   */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!justFired()) return;
    firedAt.current = 0;
    e.preventDefault();
    e.stopPropagation();
  }, [justFired]);

  return {
    onPointerDown,
    onPointerUp: clear,
    onPointerMove,
    onPointerCancel: clear,
    onContextMenu,
    onClickCapture,
  };
}
