/**
 * The call, worked in the record's right pane.
 *
 * **26 September 2026, the owner**, with a design of his own: *"We want to
 * Create in UI/UX in the replacement of current note section in the right
 * pane, the size should be same as per note section/Box, this box called Call
 * deck … the Existing Functionality and Feature are work Perfect."* So the
 * shape is new and the calling and saving actions still use `useCallDeckState`.
 *
 * Top to bottom: who is next, live controls, disposition and chase date, then
 * the three ways out. The shared comments composer below is the only notes box.
 *
 * It is permanently fixed above team notes. At rest it says plainly that no
 * call is running; while the handset reports activity it follows that state;
 * and during a CRM call it expands into the full working controls.
 */
import { type JSX, useEffect, useState } from 'react';
import {
  CalendarDays, ChevronDown, Pause, PhoneCall, PhoneOff, SkipForward, Volume2, VolumeX,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLiveCall } from '../lib/liveCall';
import {
  returnToCallUrl, useCallDeckState, usePhoneReport, type CallDeckState,
} from './LiveCallDeck';
import { quickFollowUpDates } from '../lib/followUpDates';
import { Spinner } from './ui';
import { cn } from '../lib/utils';
import { useApp } from '../lib/store';
import { relativeDueDay } from '@ipropy/shared';

/**
 * One permanent home for calling, directly above Notes & Comments.
 */
export function CallDeckPanel({ module, recordId }: { module: string; recordId: string }): JSX.Element {
  const onThisRecord = useCallIsOn(module, recordId);
  const call = useLiveCall((state) => state.call);
  const userId = useApp((state) => state.user?.id ?? null);
  const report = usePhoneReport();
  if (onThisRecord) return <ActivePanel />;
  const ownedCall = call && userId && call.userId === userId ? call : null;
  return <StandbyPanel call={ownedCall} report={report} />;
}

/**
 * Whether the live call is about this very record.
 *
 * Exported because the pane has to *choose* — the deck takes the notes box's
 * place rather than stacking over it — and the two decisions have to be the
 * same one, or a screen ends up with both or neither.
 */
export function useCallIsOn(module: string, recordId: string): boolean {
  const call = useLiveCall((state) => state.call);
  const userId = useApp((state) => state.user?.id ?? null);
  return Boolean(call && userId && call.userId === userId && call.module === module && call.recordId === recordId);
}

function ActivePanel(): JSX.Element {
  const deck = useCallDeckState();
  // While this pane is up, the shell hides its return-to-call strip.
  const setInPane = useLiveCall((state) => state.setInPane);
  useEffect(() => {
    setInPane(true);
    return () => setInPane(false);
  }, [setInPane]);
  return (
    <section className="card h-fit overflow-hidden" data-testid="call-deck-panel">
      <QueueBar deck={deck} />
      <div className="space-y-2 p-3">
        <WhoAndClock deck={deck} />
        <div className="grid grid-cols-2 gap-2">
          <Outcomes deck={deck} />
          <Chase deck={deck} />
        </div>
      </div>
      <WaysOut deck={deck} />
    </section>
  );
}

/**
 * The deck at rest. It never disappears after Save & Exit, Save & Next or Not
 * Called, so there is always one reliable place to answer “am I on a call?”.
 * A handset can still report a call that did not start from this browser; that
 * activity is shown too, rather than incorrectly claiming the phone is idle.
 */
function StandbyPanel({
  call,
  report,
}: {
  call: ReturnType<typeof useLiveCall.getState>['call'];
  report: ReturnType<typeof usePhoneReport>;
}): JSX.Element {
  const phoneLive = report?.state === 'dialling'
    || report?.state === 'ringing'
    || report?.state === 'active'
    || report?.state === 'held';
  const label = call
    ? `Call active · ${call.number}`
    : phoneLive
      ? report.state === 'active' ? 'Phone call connected'
        : report.state === 'held' ? 'Phone call on hold'
          : report.state === 'ringing' ? 'Phone is ringing'
            : 'Phone is dialling'
      : 'No call in progress';
  const detail = call
    ? 'This call belongs to another record. Return to it to save the outcome.'
    : phoneLive
      ? 'Live activity reported by your phone.'
      : 'Press the Call button on this record when you are ready.';

  return (
    <section className="card h-fit overflow-hidden" data-testid="call-deck-panel">
      <header className="border-b border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2">
        <span className="text-sm font-semibold text-[var(--text)]">Call deck</span>
      </header>
      <div className="flex items-center gap-2.5 p-3" data-testid="call-panel-status">
        <span className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          phoneLive || call ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300',
        )}>
          <PhoneCall className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[var(--text)]">{label}</span>
          <span className="block text-xs text-muted">{detail}</span>
        </span>
        {call && (
          <Link className="btn-secondary btn-sm shrink-0" to={returnToCallUrl(call)}>
            Open call
          </Link>
        )}
      </div>
    </section>
  );
}

/** Where this record sits in the list being worked, and who is next. */
function QueueBar({ deck }: { deck: CallDeckState }): JSX.Element {
  return (
    <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-subtle)] px-3 py-2">
      <span className="min-w-0 truncate text-sm font-semibold text-[var(--text)]" title={deck.who}>{deck.who}</span>
      {deck.nextLabel && (
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-800 dark:bg-brand-950/60 dark:text-brand-200">
          <SkipForward className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {/* Not `opacity-70`: at 70% over the chip's own tint this word came
              out at 4.43:1 under the violet palette — a serious contrast
              violation the scan catches. Weight says "secondary" without
              touching the colour. */}
          <span className="shrink-0 font-medium">Next:</span>
          <span className="truncate font-bold">{deck.nextLabel}</span>
        </span>
      )}
    </header>
  );
}

/** Who is on the call, then the clock and what can be done to it. */
function WhoAndClock({ deck }: { deck: CallDeckState }): JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-2 py-1.5">
        <CallBarStrip deck={deck} />
        {/*
          End is red and apart, the way a phone draws it. The other three are
          plain circles: Android lets only a phone's *calling app* touch a
          running call, so they light up when the phone says it can and are
          drawn dead with the reason when it cannot — never a button that
          looks alive and does nothing.
        */}
        <RoundButton
          label="End call"
          enabled={deck.canEndCall}
          reason={deck.noControlReason}
          danger
          onClick={deck.onHangUp}
        >
          <PhoneOff className="h-4 w-4" />
        </RoundButton>
        <RoundButton
          label={deck.held ? 'On hold' : 'Hold'}
          on={deck.held}
          enabled={deck.canControl}
          reason={deck.noControlReason}
          onClick={() => deck.onControl('hold', !deck.held)}
        >
          <Pause className="h-4 w-4" />
        </RoundButton>
        <RoundButton
          label={deck.speakerOn ? 'Speaker on' : 'Speaker'}
          on={deck.speakerOn}
          enabled={deck.canControl}
          reason={deck.noControlReason}
          onClick={() => deck.onControl('speaker', !deck.speakerOn)}
        >
          {deck.speakerOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </RoundButton>
      </div>
    </>
  );
}

/**
 * The bar and the clock, in place of nine words that never changed.
 *
 * **27 September 2026, the owner:** *"We need a call Bar and Call timer in
 * replacement of 'calling on your phone' in the call deck."* Every handset in
 * this business runs a build that predates the plugin which reports a call's
 * state, so "Calling on your phone" is what the deck said for the whole of
 * every call — the same sentence whether the phone was ringing, connected or
 * long since hung up.
 *
 * The clock is always there and always honest: time since Call was pressed,
 * which is the one thing this computer knows. The phase word and the talk time
 * appear only when the phone has actually said something.
 */
function CallBarStrip({ deck }: { deck: CallDeckState }): JSX.Element {
  const { phase, elapsed, talkTime, moving, connected } = deck.bar;
  return (
    <span className="min-w-0 flex-1 rounded bg-[var(--surface-subtle)] px-2 py-1" data-testid="call-panel-status">
      <span className="flex items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            connected ? 'bg-positive' : moving ? 'animate-pulse bg-brand-600' : 'bg-slate-300',
          )}
          aria-hidden
        />
        {connected && <Equaliser />}
        {/*
          A word only when the phone has actually said one. With nothing known
          the bar and the clock say everything there is to say — which is the
          whole of *"in replacement of 'calling on your phone'"* — and the row
          has four controls on it, so a placeholder would be squeezed to "Call…"
          and say less than nothing.
        */}
        {phase && <span className="min-w-0 flex-1 truncate text-xs font-semibold text-muted">{phase}</span>}
        <span
          className={cn(
            'text-sm font-extrabold tabular-nums text-[var(--text)] dark:text-slate-100',
            phase ? 'shrink-0' : 'flex-1',
          )}
          title={talkTime ? `Talking for ${talkTime}` : 'Since Call was pressed'}
        >
          {talkTime ?? elapsed}
        </span>
      </span>
      {/*
        The bar itself. It sweeps while the call is going and holds still once
        it is over, so a glance says "this is live" without reading a word.
      */}
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-[var(--border)]" aria-hidden>
        <span
          className={cn(
            'block h-full rounded-full',
            connected ? 'w-full bg-positive' : moving ? 'w-1/3 animate-call-sweep bg-brand-600' : 'w-full bg-slate-300',
          )}
        />
      </span>
    </span>
  );
}

/**
 * How the call went, in the admin's own words.
 *
 * Never a list written here: an outcome added in Settings has to be offered
 * the same afternoon, and one the server would refuse must never be on screen.
 * An outcome nobody has described still appears, so a rep can always record it.
 */
function Outcomes({ deck }: { deck: CallDeckState }): JSX.Element {
  return (
    <label className="relative min-w-0">
      <span className="sr-only">Call disposition</span>
      <PhoneCall className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-brand-700" aria-hidden />
      <select value={deck.outcome} onChange={(event) => deck.onOutcome(event.target.value)} aria-label="Call disposition" className="input h-9 w-full appearance-none rounded-full bg-brand-50 py-1 pl-8 pr-8 text-xs font-semibold text-brand-800 dark:bg-brand-950/50 dark:text-brand-100">
        {deck.outcomes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-brand-700" aria-hidden />
    </label>
  );
}

/**
 * When to chase them — one dropdown, and it can be read.
 *
 * **27 September 2026, the owner, with a screenshot:** *"in the call deck auto
 * follow up dropdown not visible property."* It was a four-column grid of
 * buttons at the very bottom of the panel — Today, Tomorrow, Next Week, Next
 * Month — inside a `card` that is `overflow-hidden`, so at the widths a right
 * pane actually gets the last two were cut through the middle of a word and the
 * row sat on the panel's own edge.
 *
 * A native `<select>` is the fix rather than a prettier popover: the browser
 * draws its list outside the panel entirely, so nothing this card does to its
 * own overflow can ever clip it again — on a laptop or inside the phone app.
 *
 * **Three states, and the first is the one that was unsayable.** "Let the
 * outcome decide" is what the CRM has always done and is still the default;
 * "No follow-up" is a rep saying on purpose that nobody should be chased; and a
 * day is a day. The label prints what will actually happen, from the same value
 * the save reads — so a dropdown promising tomorrow and a date landing next
 * week is not expressible.
 */
function Chase({ deck }: { deck: CallDeckState }): JSX.Element {
  const [choosingDate, setChoosingDate] = useState(false);
  const choices = quickFollowUpDates();
  const existing = deck.existingFollowUp;
  const due = relativeDueDay(existing);
  const autoLabel = due
    ? due.tone === 'today' || due.tone === 'tomorrow' || due.tone === 'overdue'
      ? due.label
      : readableDay(existing!.slice(0, 10))
    : 'Pending';
  const value = deck.followUp === undefined ? 'auto' : deck.followUp === null ? 'none' : deck.followUp;
  // A day the rep typed rather than tapped — it belongs in the list, or the
  // control would read as nothing chosen while a date is plainly set.
  const custom = typeof deck.followUp === 'string' && !choices.some((c) => c.value === deck.followUp)
    ? deck.followUp
    : null;

  return (
    <div className="relative min-w-0">
      <label className="sr-only" htmlFor="call-deck-followup">Next follow-up</label>
      <CalendarDays className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-brand-700" aria-hidden />
        <select
          id="call-deck-followup"
          data-testid="call-deck-followup"
          className="input h-9 w-full appearance-none rounded-full bg-brand-50 py-1 pl-8 pr-8 text-xs font-semibold text-brand-800 dark:bg-brand-950/50 dark:text-brand-100"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'custom') { setChoosingDate(true); return; }
            setChoosingDate(false);
            deck.onFollowUp(next === 'auto' ? undefined : next === 'none' ? null : next);
          }}
        >
          <option value="auto">{autoLabel}</option>
          <option value="none">No follow-up</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label} — {readableDay(choice.value)}
            </option>
          ))}
          {custom && <option value={custom}>{readableDay(custom)}</option>}
          <option value="custom">Choose date…</option>
        </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-brand-700" aria-hidden />
      {choosingDate && (
        <input
          type="date"
          aria-label="Chase them on another day"
          autoFocus
          className="input mt-1 h-9 w-full text-xs"
          value={typeof deck.followUp === 'string' ? deck.followUp : ''}
          onChange={(event) => {
            if (event.target.value) { deck.onFollowUp(event.target.value); setChoosingDate(false); }
          }}
        />
      )}
    </div>
  );
}

/** "28 Sep" — the day itself, so a choice is not taken on trust. */
function readableDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** The three ways out. Two of them keep the call; one says it never happened. */
function WaysOut({ deck }: { deck: CallDeckState }): JSX.Element {
  return (
    <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-subtle)] p-2">
      <button
        type="button"
        onClick={deck.onDiscard}
        disabled={deck.saving}
        title="Nobody was spoken to — write nothing"
        className="btn-secondary btn-sm shrink-0"
      >
        Not Called
      </button>
      <button
        type="button"
        onClick={() => deck.onSave(false)}
        disabled={deck.saving}
        title="Save this call and keep the call deck ready"
        className="btn-secondary btn-sm min-w-0 flex-1"
      >
        {deck.saving && <Spinner className="h-3 w-3" />}
        <span className="truncate">Save &amp; Exit</span>
      </button>
      {deck.nextLabel && (
        <button
          type="button"
          onClick={() => deck.onSave(true)}
          disabled={deck.saving}
          title={deck.confirmNext
            ? `Save this call and prepare ${deck.nextLabel}; you will confirm before it rings`
            : `Save this call and ring ${deck.nextLabel}`}
          className="btn-primary btn-sm shrink-0"
        >
          {deck.confirmNext ? 'Save & Prepare Next →' : 'Save & Next →'}
        </button>
      )}
    </footer>
  );
}

/**
 * One round control. Lit when that switch is on, so the desk and the handset
 * read the same; a dead one says why rather than pretending.
 */
function RoundButton({ label, enabled, on = false, reason, danger, onClick, children }: {
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
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors',
        danger ? 'border-transparent bg-negative-soft text-negative-on-soft hover:bg-red-200'
          : on ? 'border-transparent bg-brand-600 text-white'
            : 'border-[var(--border)] text-muted hover:bg-[var(--surface-muted)]',
        !enabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/** Three bars that rise and fall, the way a call looks on a phone. */
function Equaliser(): JSX.Element {
  return (
    <span className="flex h-4 shrink-0 items-end gap-[2px]" aria-hidden="true">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="w-[2px] rounded-sm bg-positive animate-equalise"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
