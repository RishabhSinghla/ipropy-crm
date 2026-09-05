import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldMeta } from '@ipropy/shared';

/**
 * Per-column widths for a list, dragged by the user and remembered.
 *
 * Two decisions worth knowing:
 *
 * **Stored per module and column name, not per view.** A rep who widens
 * "Full Name" means it everywhere — the column is the same column on every
 * tab, and keying by view made the width vanish each time somebody switched
 * from All Contacts to Today's Follow-ups.
 *
 * **Every column gets an explicit width, always.** The table is
 * `table-layout: fixed`, which is what makes a drag cheap (no reflow of the
 * other columns) and what makes `truncate` mean anything. A fixed table with
 * no widths divides the space equally, so a date column would be as wide as a
 * name — hence the type-derived defaults below, which are the starting point
 * before anybody drags anything.
 *
 * localStorage can throw outright in a locked-down browser or a private
 * window, so every read and write is guarded and the list simply falls back to
 * the defaults.
 */

const PREFIX = 'ipropy.colwidths.';
export const MIN_WIDTH = 64;
/**
 * Not a real constraint — a drag is clamped only at the bottom — but a
 * focusable `role="separator"` has to announce a range, and "up to 0" is worse
 * than a generous honest ceiling. Wide enough that nobody meets it by dragging.
 */
export const MAX_WIDTH = 1200;

/** The tick-box column. Not resizable, so it is not part of the stored map. */
export const SELECT_COL_WIDTH = 40;

/** Sensible starting width by what the column holds. */
export function defaultWidth(field: FieldMeta | undefined): number {
  switch (field?.uitype) {
    case 'boolean': case 'integer': case 'percent': case 'score': return 96;
    case 'date': return 118;
    case 'datetime': return 150;
    case 'picklist': case 'multipicklist': case 'tags': return 156;
    case 'currency': case 'decimal': case 'area': return 132;
    case 'phone': return 152;
    case 'email': case 'url': return 220;
    case 'owner': case 'user': case 'reference': return 168;
    case 'textarea': case 'richtext': return 260;
    default: return 172;
  }
}

function read(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [col, w] of Object.entries(parsed)) {
      if (typeof w === 'number' && Number.isFinite(w) && w >= MIN_WIDTH) out[col] = w;
    }
    return out;
  } catch {
    return {};
  }
}

function write(key: string, widths: Record<string, number>): void {
  try {
    if (Object.keys(widths).length) localStorage.setItem(PREFIX + key, JSON.stringify(widths));
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // Private window or blocked site data. The widths still work for this
    // session; they just don't survive a reload.
  }
}

export interface ColumnWidths {
  /** The width to paint for a column, stored or default. */
  widthOf: (col: string, field: FieldMeta | undefined) => number;
  /** Begin a drag from a header divider. */
  beginResize: (col: string, startWidth: number, event: React.PointerEvent) => void;
  /** The column currently being dragged, for the handle's active styling. */
  resizing: string | null;
  /** Keyboard resize from the focused divider. */
  nudge: (col: string, currentWidth: number, delta: number) => void;
  /** Double-click a divider: back to the type-derived default. */
  resetColumn: (col: string) => void;
  /** Every column back to its default. */
  resetAll: () => void;
  /** Whether anything has been dragged — the "Reset column widths" item hides otherwise. */
  customised: boolean;
}

export function useColumnWidths(moduleName: string | undefined): ColumnWidths {
  const key = moduleName ?? '';
  const [widths, setWidths] = useState<Record<string, number>>(() => (key ? read(key) : {}));
  const [resizing, setResizing] = useState<string | null>(null);
  // The drag's own numbers, kept out of state: a pointermove fires at screen
  // refresh rate and re-rendering the whole grid to remember a start offset
  // made the divider lag behind the cursor on a long list.
  const drag = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => { setWidths(key ? read(key) : {}); }, [key]);

  const widthOf = useCallback(
    (col: string, field: FieldMeta | undefined): number => widths[col] ?? defaultWidth(field),
    [widths],
  );

  const beginResize = useCallback((col: string, startWidth: number, event: React.PointerEvent): void => {
    // The header is also a sort button; a drag that starts on the divider must
    // not end as a sort.
    event.preventDefault();
    event.stopPropagation();
    drag.current = { col, startX: event.clientX, startWidth };
    setResizing(col);
    document.body.classList.add('resizing-columns');

    const move = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      const next = Math.max(MIN_WIDTH, Math.round(d.startWidth + (e.clientX - d.startX)));
      setWidths((prev) => (prev[d.col] === next ? prev : { ...prev, [d.col]: next }));
    };
    const end = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-columns');
      drag.current = null;
      setResizing(null);
      // Persist once, at the end. Writing on every move serialises the whole
      // map a hundred times per drag.
      setWidths((current) => { if (key) write(key, current); return current; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }, [key]);

  const nudge = useCallback((col: string, currentWidth: number, delta: number): void => {
    const next = Math.max(MIN_WIDTH, currentWidth + delta);
    setWidths((prev) => {
      const updated = { ...prev, [col]: next };
      if (key) write(key, updated);
      return updated;
    });
  }, [key]);

  const resetColumn = useCallback((col: string): void => {
    setWidths((prev) => {
      if (prev[col] === undefined) return prev;
      const next = { ...prev };
      delete next[col];
      if (key) write(key, next);
      return next;
    });
  }, [key]);

  const resetAll = useCallback((): void => {
    setWidths({});
    if (key) write(key, {});
  }, [key]);

  return {
    widthOf, beginResize, nudge, resizing, resetColumn, resetAll,
    customised: Object.keys(widths).length > 0,
  };
}
