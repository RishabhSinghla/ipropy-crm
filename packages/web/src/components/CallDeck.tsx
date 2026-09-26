import { type JSX, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { GripVertical, MicOff, Pause, PhoneOff, RotateCcw, Volume2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { Spinner } from './ui';
import { type DeckSpot, forgetDeckSpot, keepOnScreen, loadDeckSpot, saveDeckSpot } from '../lib/dragDeck';

/**
 * The live call, floating over whatever screen the rep is on.
 *
 * **24 September 2026, the owner**, with a design of his own: the call sits
 * in the record's header rather than a dialog over it. **26 September:** it
 * follows the rep to any screen until the call is saved, stays wherever it is
 * dragged, and has no close button — Save & Exit and Save & Next are the two
 * ways out, and both keep the call.
 *
 * Two rows, divided, as he drew them: who, the status and the call's own
 * controls above; where the call is in the queue and the way out below.
 *
 * **Speaker, mute, hold and end are real only when the phone says so.**
 * Android lets only a phone's *calling app* touch a running call, so they
 * light up once iPropy is the rep's calling app and show what the phone
 * reports — a tap on the handset lights the button here too. Otherwise they
 * are drawn dead with the reason, never a button that does nothing.
 */
export interface CallDeckProps {
  /** "Ringing…", the clock from when they answered, "On hold · 01:05", "Call ended · 02:10". */
  status: string;
  /** Whether the call is up and talking — the equaliser moves only then. */
  talking: boolean;
  /** Speaker, mute and hold: whether each is on, as the phone reports it. */
  speakerOn: boolean;
  muted: boolean;
  held: boolean;
  /** Whether the phone lets the CRM switch those at all (iPropy is its calling app). */
  canControl: boolean;
  /** Why the switches are dead, when they are. */
  noControlReason: string;
  onControl: (action: 'speaker' | 'mute' | 'hold', on: boolean) => void;
  /** Whether this rep's phone has told us it can hang up. */
  canEndCall: boolean;
  onHangUp: () => void;
  /** Where this record sits in the queue being worked, 1-based. */
  position: number | null;
  total: number | null;
  /** Who the call is with, so the deck says so on any screen. */
  who: string;
  /** The admin's own outcome list, and the one chosen. */
  outcomes: string[];
  outcome: string;
  onOutcome: (value: string) => void;
  saving: boolean;
  /** The next record's name; null when there is no next one. */
  nextLabel: string | null;
  onSave: (andDialNext: boolean) => void;
  /** Where the record's header wants it, when it has not been moved. */
  dock: { top: number; left: number } | null;
}

export function CallDeck({
  status, talking, speakerOn, muted, held, canControl, noControlReason, onControl,
  canEndCall, onHangUp, position, total, who, outcomes, outcome, onOutcome,
  saving, nextLabel, onSave, dock,
}: CallDeckProps): JSX.Element {
  const { box, spot, grab, putBack } = useMovable();
  /*
    Always pinned to the window, never inside a page, so moving from one
    screen to another cannot take it away. Where it goes: where it was
    dragged, else where the record's header docks it, else the top-right.
  */
  const place = spot
    ? { left: spot.left, top: spot.top }
    : dock ?? { top: 64, left: Math.max(8, window.innerWidth - 384) };

  return (
    <div
      ref={box}
      data-testid="call-deck"
      style={{ position: 'fixed', left: place.left, top: place.top, zIndex: 60 }}
      className="w-[23rem] rounded-xl bg-slate-900 px-2.5 py-1.5 text-white shadow-float dark:bg-black"
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
          title={spot ? 'Drag to move · double-click to put it back' : 'Drag to move it anywhere'}
          aria-label="Move the call panel"
          className="-ml-1 cursor-grab touch-none text-slate-500 hover:text-white active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-semibold text-slate-300">{who}</span>
          <span className="block text-sm font-bold tabular-nums" data-testid="call-status">{status}</span>
        </span>
        {talking && <Equaliser />}
        <span className="ml-auto flex items-center gap-1">
          <DeckButton label={speakerOn ? 'Speaker on' : 'Speaker'} on={speakerOn} enabled={canControl} reason={noControlReason} onClick={() => onControl('speaker', !speakerOn)}>
            <Volume2 className="h-3.5 w-3.5" />
          </DeckButton>
          <DeckButton label={muted ? 'Muted' : 'Mute'} on={muted} enabled={canControl} reason={noControlReason} onClick={() => onControl('mute', !muted)}>
            <MicOff className="h-3.5 w-3.5" />
          </DeckButton>
          <DeckButton label={held ? 'On hold' : 'Hold'} on={held} enabled={canControl} reason={noControlReason} onClick={() => onControl('hold', !held)}>
            <Pause className="h-3.5 w-3.5" />
          </DeckButton>
          <DeckButton label="End call" enabled={canEndCall} reason={noControlReason} danger onClick={onHangUp}>
            <PhoneOff className="h-3.5 w-3.5" />
          </DeckButton>
          {spot && (
            <DeckButton label="Put it back" enabled reason="" onClick={putBack}>
              <RotateCcw className="h-3.5 w-3.5" />
            </DeckButton>
          )}
        </span>
      </div>

      {/* The divider the owner drew: above is the call itself, below is what becomes of it. */}
      <div className="my-1.5 border-t border-white/15" />

      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-slate-400">
          {position && total ? `${position} / ${total}` : '—'}
        </span>
        {/*
          What was said, in the admin's own words — never a list written here,
          so an outcome added in Settings is offered the same afternoon.
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
        {/*
          Two ways out, both of which save (26 September 2026, the owner):
          Save & Exit closes the call here; Save & Next rings the next person
          in the list. There is no way out that forgets the call.
        */}
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(false)}
          title="Save this call and close the panel"
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/15 px-2 py-1 text-xs font-bold text-white hover:bg-white/25 disabled:opacity-60"
        >
          {saving && <Spinner className="h-3 w-3" />}
          Save &amp; Exit
        </button>
        {nextLabel && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave(true)}
            title={`Save this call and ring ${nextLabel}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-700 px-2 py-1 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-60"
          >
            Save &amp; Next
          </button>
        )}
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

/**
 * One round control on the deck. Lit when that switch is on, so the desk and
 * the phone read the same; dead ones say why rather than pretending.
 */
function DeckButton({ label, enabled, on = false, reason, danger, onClick, children }: {
  label: string; enabled: boolean; on?: boolean; reason: string; danger?: boolean;
  onClick?: () => void; children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      aria-pressed={danger ? undefined : on}
      title={enabled ? label : `${label} — ${reason}`}
      aria-label={enabled ? label : `${label}, unavailable. ${reason}`}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors',
        danger ? 'bg-red-500 text-white' : on ? 'bg-emerald-500 text-white' : 'bg-white/10 text-slate-200',
        enabled ? (danger ? 'hover:bg-red-400' : 'hover:bg-white/25') : 'cursor-not-allowed opacity-40',
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
