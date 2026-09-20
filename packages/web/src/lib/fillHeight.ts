import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Measure how far down the page a pane starts, so it can take the rest.
 *
 * **This repo has now paid for the same guess twice.** The split view's panes
 * were `calc(100vh - 13rem)` — a stand-in for whatever toolbar sits above —
 * and it was about a hundred pixels out, which the owner reported as a white
 * gap under the queue. The Chats screen carried `calc(100vh - 3.5rem)`, a
 * stand-in for the app header, and on 20 September it moved inside a page with
 * a tab strip above it: the composer went off the bottom of the screen, and
 * from a screenshot that reads as a broken chat window.
 *
 * A number that encodes where something else is will be wrong the day that
 * something else changes, and nothing fails when it does. Measuring is exact,
 * and stays exact when the toolbar above grows a row.
 *
 * Returns a ref to put on the pane and the pixel height it should be.
 */
export function useFillHeight<T extends HTMLElement>(): [RefObject<T | null>, number | null] {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const measure = (): void => {
      const box = ref.current?.getBoundingClientRect();
      if (box) setHeight(Math.max(240, Math.round(window.innerHeight - box.top)));
    };
    measure();
    window.addEventListener('resize', measure);
    /*
      Not only on resize. The strip above this one can appear, disappear or
      change height without the window moving at all — a tab row that renders
      after its permissions arrive is exactly that — and a window listener
      never hears it.
    */
    const observer = new ResizeObserver(measure);
    if (ref.current?.parentElement) observer.observe(ref.current.parentElement);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, []);

  return [ref, height];
}
