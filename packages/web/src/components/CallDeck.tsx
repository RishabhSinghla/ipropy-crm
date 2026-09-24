import { type JSX, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { Grid3x3, GripVertical, MicOff, PhoneOff, RotateCcw, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { elapsedLabel, mayControlLiveCall, NO_LIVE_CONTROL_REASON } from '../lib/callConsole';
import { Spinner } from './ui';
import { type DeckSpot, forgetDeckSpot, keepOnScreen, loadDeckSpot, saveDeckSpot } from '../lib/dragDeck';

/**
 * The live call, in the record's own header.
 *
 * **24 September 2026, the owner**, with a design of his own: *"we dont want
 * that full popup and things opening when click call button but instead now I
 * want it like this."* Pressing Call used to cover the record with a dialog —
 * so the one screen a rep needs while talking, the record, was behind the
 * thing they pressed to start talking. The deck sits in the header instead and
 * the record stays where it is: status, follow-up date and notes are all
 * editable in place, which is what the split view is for.
 *
 * Two rows, divided, exactly as he drew them: the clock and the call's own
 * controls above, where the call is in the queue and the way out below.
 *
 * **Mute and keypad are drawn and dead on purpose.** Android hands a running
 * call to the handset's *default phone app* and to nobody else; iPropy gives a
 * number to the dialler and reads the call log afterwards. A control that
 * looks alive and does nothing is the failure this repo keeps writing down, so
 * they carry the reason in their tooltip and light up on their own the day
 * `mayControlLiveCall` says the app may touch a live call.
 */
export interface CallDeckProps {
  /** Seconds are counted from here; null before the call is placed. */
  startedAt: number | null;
  /** True while the CRM is still asking a phone to ring. */
  placing: boolean;
  /** Where this record sits in the queue being worked, 1-based. */
  position: number | null;
  total: number | null;
  /** The admin's own outcome list, and the one chosen. */
  outcomes: string[];
  outcome: string;
  onOutcome: (value: string) => void;
  /** Whether this rep's phone has told us it can hang up. */
  canEndCall: boolean;
  onHangUp: () => void;
  saving: boolean;
  /** Save the call and open the next record; null when there is no next one. */
  nextLabel: string | null;
  onSave: (andDialNext: boolean) => void;
  /** Throw the call away without writing anything. */
  onDiscard: () => void;
}

export function CallDeck({
  startedAt, placing, position, total, outcomes, outcome, onOutcome,
  canEndCall, onHangUp, saving, nextLabel, onSave, onDiscard,
}: CallDeckProps): JSX.Element {
  const timer = useElapsed(startedAt);
  const liveControls = mayControlLiveCall({ endCall: canEndCall });
  const { box, spot, grab, putBack } = useMovable();

  return (
    <div
      ref={box}
      data-testid="call-deck"
      /*
        Docked in the header until somebody moves it, and pinned to the window
        once they have. Two positions rather than one because the dock has to
        follow the header as the page scrolls, and a deck dropped somewhere
        deliberately has to stay exactly where it was put.
      */
      style={spot ? { position: 'fixed', left: spot.left, top: spot.top, right: 'auto' } : undefined}
      className="w-[19rem] shrink-0 rounded-xl bg-slate-900 px-2.5 py-1.5 text-white shadow-float dark:bg-black"
    >
      <div className="flex items-center gap-2">
        {/*
          The grip. Dragging from anywhere else would mean a rep who meant to
          press End nudges the deck instead, mid-call.
        */}
        <button
          type="button"
          onPointerDown={grab}
          onDoubleClick={putBack}
          title={spot ? 'Drag to move · double-click to put it back in the header' : 'Drag to move it anywhere'}
          aria-label="Move the call panel"
          className="-ml-1 cursor-grab touch-none text-slate-500 hover:text-white active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="text-sm font-bold tabular-nums">
          {placing ? 'Ringing…' : timer}
        </span>
        <Equaliser />
        <span className="ml-auto flex items-center gap-1">
          <DeckButton label="Mute" enabled={liveControls}><MicOff className="h-3.5 w-3.5" /></DeckButton>
          <DeckButton label="Keypad" enabled={liveControls}><Grid3x3 className="h-3.5 w-3.5" /></DeckButton>
          <DeckButton label="End call" enabled={canEndCall} danger onClick={onHangUp}>
            <PhoneOff className="h-3.5 w-3.5" />
          </DeckButton>
          {spot && (
            <DeckButton label="Put it back in the header" enabled onClick={putBack}>
              <RotateCcw className="h-3.5 w-3.5" />
            </DeckButton>
          )}
          <DeckButton label="Did not call" enabled onClick={onDiscard}>
            <X className="h-3.5 w-3.5" />
          </DeckButton>
        </span>
      </div>

      {/* The divider the owner drew, and it earns its keep: above is the call
          itself, below is what becomes of it. */}
      <div className="my-1.5 border-t border-white/15" />

      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-slate-400">
          {position && total ? `${position} / ${total}` : '—'}
        </span>
        {/*
          What was said, in the admin's own words — never a list written here,
          so an outcome added in Settings is offered the same afternoon. A call
          saved with no outcome is a row nobody can report on, which is why it
          is on the deck rather than left behind with the dialog.
        */}
        <select
          value={outcome}
          onChange={(event) => onOutcome(event.target.value)}
          aria-label="How the call went"
          className="min-w-0 flex-1 rounded-md border-0 bg-white/10 px-1.5 py-1 text-xs font-medium text-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
        >
          {outcomes.map((value) => (
            <option key={value} value={value} className="text-slate-900">{value}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(Boolean(nextLabel))}
          title={nextLabel ? `Save this call and ring ${nextLabel}` : 'Save this call'}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-bold text-white hover:bg-emerald-400 disabled:opacity-60"
        >
          {saving && <Spinner className="h-3 w-3" />}
          {nextLabel ? 'Save & Next' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * Pick the deck up, put it down, and find it there next time.
 *
 * It starts docked — no `spot`, so the header positions it — and switches to
 * being pinned to the window **at the pixel it already occupies**, so the
 * first drag does not make it jump before it moves. `setPointerCapture` is
 * what keeps a fast drag from letting go halfway across the screen, the same
 * reason the split view's own divider uses it.
 */
function useMovable(): {
  box: React.RefObject<HTMLDivElement | null>;
  spot: DeckSpot | null;
  grab: (event: ReactPointerEvent<HTMLElement>) => void;
  putBack: () => void;
} {
  const box = useRef<HTMLDivElement | null>(null);
  const [spot, setSpot] = useState<DeckSpot | null>(() => loadDeckSpot());

  // A deck left near an edge, on a window that has since been made smaller,
  // would be off the screen with a live call inside it.
  useEffect(() => {
    if (!spot) return;
    const onResize = (): void => setSpot((current) => (current ? keepOnScreen(
      current,
      { width: box.current?.offsetWidth ?? 304, height: box.current?.offsetHeight ?? 80 },
      { width: window.innerWidth, height: window.innerHeight },
    ) : current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [spot]);

  const grab = (event: ReactPointerEvent<HTMLElement>): void => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const from = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    const move = (e: PointerEvent): void => {
      setSpot(keepOnScreen(
        { left: e.clientX - from.x, top: e.clientY - from.y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    const drop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', drop);
      setSpot((current) => { if (current) saveDeckSpot(current); return current; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', drop);
    // Pinned where it already is, so the drag starts from here rather than
    // snapping to the pointer.
    setSpot({ left: rect.left, top: rect.top });
  };

  const putBack = (): void => { forgetDeckSpot(); setSpot(null); };

  return { box, spot, grab, putBack };
}

/** The clock, ticking. Nothing else on the page moves while a call is live. */
function useElapsed(startedAt: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return elapsedLabel(startedAt ? Date.now() - startedAt : 0);
}

/** One round control on the deck. Dead ones say why rather than pretending. */
function DeckButton({ label, enabled, danger, onClick, children }: {
  label: string; enabled: boolean; danger?: boolean; onClick?: () => void; children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      title={enabled ? label : `${label} — ${NO_LIVE_CONTROL_REASON}`}
      aria-label={enabled ? label : `${label}, unavailable. ${NO_LIVE_CONTROL_REASON}`}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors',
        danger ? 'bg-red-500 text-white' : 'bg-white/10 text-slate-200',
        enabled ? 'hover:bg-white/25' : 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/** Three bars that rise and fall, the way a call looks on a phone. */
function Equaliser(): JSX.Element {
  return (
    <span className="flex items-end gap-[2px]" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="w-[2px] rounded-sm bg-emerald-400 animate-equalise"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
