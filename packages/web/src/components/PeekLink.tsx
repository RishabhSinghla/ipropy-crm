import { createContext, type JSX, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
/**
 * A link to a record that also answers "who is this?" without going there.
 *
 * Records are listed in a dozen places that are not the list view — dashboard
 * widgets, the AI's answers, related lists, a lookup field's value — and on a
 * phone every one of them costs the same round trip: open, read one line, press
 * back, lose your place. The list view solved that with press-and-hold; this is
 * the same gesture everywhere else.
 *
 * **One dialog, not one per link.** The peek is hoisted to a provider near the
 * root, so a widget showing ten rows renders ten links and no dialogs, and
 * peeking from inside a peek (a lead's "Interested In" leading to the unit)
 * swaps the target rather than stacking a second modal on top of the first.
 */
import { Link, useNavigate } from 'react-router-dom';
import { usePressPreview } from '../lib/pressPreview';
import { RecordPeekById } from './RecordPeek';

export interface PeekTarget { module: string; id: string; label: string }

const PeekContext = createContext<((target: PeekTarget) => void) | null>(null);

/**
 * Renders the single peek dialog and lets anything below it ask for a peek.
 *
 * Mounted inside the router (it navigates on "Open") and above the header, so
 * global search shares it with the pages.
 */
export function PeekProvider({ children }: { children: ReactNode }): JSX.Element {
  const [target, setTarget] = useState<PeekTarget | null>(null);
  const navigate = useNavigate();

  const peek = useCallback((next: PeekTarget) => setTarget(next), []);

  return (
    <PeekContext.Provider value={peek}>
      {children}
      <RecordPeekById
        target={target}
        onOpen={() => {
          const current = target;
          setTarget(null);
          if (current) navigate(`/${current.module}/${current.id}`);
        }}
        onClose={() => setTarget(null)}
      />
    </PeekContext.Provider>
  );
}

/**
 * Ask for a peek from a component that draws its own trigger.
 *
 * Returns null outside a provider — callers must treat the gesture as
 * unavailable rather than crashing a screen over a preview.
 */
export function usePeek(): ((target: PeekTarget) => void) | null {
  return useContext(PeekContext);
}

/**
 * A record link with the press-and-hold peek attached.
 *
 * Deliberately a real `<Link>`: cmd-click still opens a background tab, the
 * status bar still shows where it goes, and middle-click still works. The
 * gesture is touch-only (see `usePressPreview`), so nothing changes for a
 * mouse.
 */
export function PeekLink({
  module, id, label, className, title, children, onNavigate,
}: {
  module: string;
  id: string;
  label: string;
  className?: string;
  title?: string;
  children: ReactNode;
  /** Fires only on an ordinary left click — a modified click leaves this page alone. */
  onNavigate?: () => void;
}): JSX.Element {
  const peek = usePeek();
  const press = usePressPreview(
    useMemo(() => () => peek?.({ module, id, label }), [peek, module, id, label]),
    Boolean(peek),
  );

  return (
    <Link
      {...press}
      to={`/${module}/${id}`}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        onNavigate?.();
      }}
      className={className}
    >
      {children}
    </Link>
  );
}
