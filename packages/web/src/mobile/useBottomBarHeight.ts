/**
 * The tab bar measures itself and publishes `--bottom-nav-h`.
 *
 * Anything else pinned to the bottom of a phone screen — the floating add
 * button, the site-visit Save bar, the space a list leaves under its last row —
 * has to clear this bar, and the only two ways to know how tall it is were a
 * hardcoded pixel count or this. The hardcoded version is wrong the moment a
 * tab label wraps, a handset has a deeper gesture area, or somebody turns the
 * system font up. Being wrong means a control half-hidden behind the
 * navigation, which is a bug that shipped on the web once already.
 *
 * Zero when the bar is not rendered, so a screen that hides it needs no
 * special case.
 */
import { useCallback, useEffect, useRef } from 'react';

export function useBottomBarHeight<T extends HTMLElement>(): (node: T | null) => void {
  const observer = useRef<ResizeObserver | null>(null);

  const publish = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) {
      document.documentElement.style.setProperty('--bottom-nav-h', '0px');
      return;
    }
    const set = (): void => {
      document.documentElement.style.setProperty('--bottom-nav-h', `${node.offsetHeight}px`);
    };
    set();
    observer.current = new ResizeObserver(set);
    observer.current.observe(node);
  }, []);

  useEffect(() => () => {
    observer.current?.disconnect();
    document.documentElement.style.setProperty('--bottom-nav-h', '0px');
  }, []);

  return publish;
}
