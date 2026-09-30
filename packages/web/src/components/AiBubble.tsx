/**
 * Ask AI, as a small floating circle that can be dragged anywhere.
 *
 * **1 October 2026, the owner:** *"I want it like assistive touch in iphone so
 * anywhere draggable inside whole CRM that small circle of AI"*. It replaces
 * the Ask AI button in the top bar.
 *
 * A tap opens the assistant; a drag moves the circle and does not. Where it was
 * left is remembered in this browser (as a share of the window, so a smaller
 * window still has it on screen) — a per-person convenience, not a setting.
 */
import { type JSX, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

const SIZE = 44;
const STORE = 'ipropy.aiBubble';
/** How far a pointer may wander before a press counts as a drag, not a tap. */
const DRAG_SLOP = 5;

type Spot = { x: number; y: number };

function loadSpot(): Spot {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Spot | null;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') return saved;
  } catch { /* private window, or blocked storage — the default corner is fine */ }
  return { x: 0.97, y: 0.86 };
}

function saveSpot(spot: Spot): void {
  try { localStorage.setItem(STORE, JSON.stringify(spot)); } catch { /* not worth interrupting anybody over */ }
}

/** Keep the whole circle inside the window. */
function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 6), Math.max(6, max - SIZE - 6));
}

export function AiBubble({ onOpen }: { onOpen: () => void }): JSX.Element {
  const [spot, setSpot] = useState<Spot>(loadSpot);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ px: number; py: number; left: number; top: number; moved: boolean } | null>(null);
  const [, redraw] = useState(0);

  // Re-clamp when the window changes size, so it can never be left off screen.
  useEffect(() => {
    const onResize = (): void => redraw((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const left = clamp(spot.x * window.innerWidth - SIZE / 2, window.innerWidth);
  const top = clamp(spot.y * window.innerHeight - SIZE / 2, window.innerHeight);

  return (
    <button
      type="button"
      aria-label="Ask iPropy AI"
      title="Ask iPropy AI — drag to move"
      data-testid="ai-bubble"
      style={{ left, top, width: SIZE, height: SIZE, touchAction: 'none' }}
      className={`fixed z-[60] flex items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-lg ring-4 ring-white/70 transition-[transform,opacity] dark:ring-slate-900/70 ${dragging ? 'scale-110 cursor-grabbing opacity-90' : 'cursor-grab opacity-80 hover:scale-105 hover:opacity-100'}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { px: event.clientX, py: event.clientY, left, top, moved: false };
      }}
      onPointerMove={(event) => {
        const from = start.current;
        if (!from) return;
        const dx = event.clientX - from.px;
        const dy = event.clientY - from.py;
        if (!from.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
        from.moved = true;
        setDragging(true);
        const nextLeft = clamp(from.left + dx, window.innerWidth);
        const nextTop = clamp(from.top + dy, window.innerHeight);
        setSpot({ x: (nextLeft + SIZE / 2) / window.innerWidth, y: (nextTop + SIZE / 2) / window.innerHeight });
      }}
      onPointerUp={() => {
        const from = start.current;
        start.current = null;
        setDragging(false);
        if (from?.moved) saveSpot(spot);
        else onOpen();
      }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}
    >
      <Sparkles className="h-5 w-5" />
    </button>
  );
}
