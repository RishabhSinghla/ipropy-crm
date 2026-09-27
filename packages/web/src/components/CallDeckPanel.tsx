/**
 * The call, worked in the record's right pane.
 *
 * **26 September 2026, the owner**, with a design of his own: *"We want to
 * Create in UI/UX in the replacement of current note section in the right
 * pane, the size should be same as per note section/Box, this box called Call
 * deck … the Existing Functionality and Feature are work Perfect."* So the
 * shape is new and nothing underneath it is: every button here drives the
 * same `useCallDeckState` the floating bar drives, and one call cannot be
 * saved two different ways.
 *
 * Top to bottom, as he drew it: where this record sits in the queue and who
 * is next; who is on the call; the clock with the live controls; the note; the
 * outcome; the chase date; and the three ways out.
 *
 * **It takes the notes panel's place only while a call is up on this record.**
 * A panel that replaced the team's notes permanently would take away the box
 * everybody writes in, and a call deck standing empty says nothing.
 */
import { type JSX, useEffect } from 'react';
import {
  CalendarDays, ChevronDown, Mic, Pause, PhoneCall, PhoneOff, SkipForward, Volume2, VolumeX,
} from 'lucide-react';
import { useLiveCall } from '../lib/liveCall';
import { useCallDeckState, type CallDeckState } from './LiveCallDeck';
import { quickFollowUpDates } from '../lib/followUpDates';
import { outcomeCard } from '../lib/callConsole';
import { Dropdown, DropdownItem, Spinner } from './ui';
import { cn } from '../lib/utils';
import { useApp } from '../lib/store';
import { useVoiceCapture } from '../lib/useVoiceCapture';
import { api } from '../lib/api';
import { toast } from '../lib/store';

/**
 * Nothing at all unless this very record is the one being called.
 *
 * The check is here rather than inside, because `useCallDeckState` assumes a
 * call exists — and because a deck drawn on a record that is not the one
 * ringing is how a note gets written against the wrong person.
 */
export function CallDeckPanel({ module, recordId }: { module: string; recordId: string }): JSX.Element | null {
  const onThisRecord = useCallIsOn(module, recordId);
  if (!onThisRecord) return null;
  return <Panel />;
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

function Panel(): JSX.Element {
  const deck = useCallDeckState();
  // While this pane is up, the floating bar stands down — and comes back the
  // moment the rep navigates away, which is what unmounting this means.
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
        <Notes deck={deck} />
        <div className="flex items-center gap-2">
          <Outcomes deck={deck} />
          <Chase deck={deck} />
        </div>
      </div>
      <WaysOut deck={deck} />
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
          <span className="shrink-0 opacity-70">Next:</span>
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
        <span className="inline-flex min-w-0 flex-1 items-center gap-2 rounded bg-[var(--surface-subtle)] px-2 py-1.5">
          {deck.talking && <span className="h-2 w-2 shrink-0 rounded-full bg-positive" aria-hidden />}
          {deck.talking && <Equaliser />}
          <span className="truncate text-sm font-bold tabular-nums text-[var(--text)] dark:text-slate-100" data-testid="call-panel-status">
            {deck.status}
          </span>
        </span>
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

/** What was said, typed while it is being said. */
function Notes({ deck }: { deck: CallDeckState }): JSX.Element {
  const voice = useVoiceCapture(async (audio) => {
    try {
      const { note } = await api.voiceNote(audio);
      deck.onNotes(deck.notes.trim() ? `${deck.notes.trim()}\n\n${note}` : note);
    } catch (error) {
      toast.error('Could not write that up', (error as Error).message);
    }
  }, {
    onTranscript: (transcript) => deck.onNotes(deck.notes.trim() ? `${deck.notes.trim()} ${transcript}` : transcript),
    serverTranscription: false,
  });
  return (
    <div className="relative">
      <textarea
        value={deck.notes}
        onChange={(event) => deck.onNotes(event.target.value)}
        placeholder={voice.interim || 'Call notes… type or dictate'}
        aria-label="Call notes"
        className="input min-h-20 resize-y pr-12 text-sm"
      />
      <button
        type="button"
        onClick={voice.toggle}
        aria-label={voice.recording ? 'Stop dictation' : 'Dictate call notes'}
        aria-pressed={voice.recording}
        disabled={voice.busy}
        title={voice.recording ? 'Stop dictation' : voice.busy ? 'Transcribing…' : 'Dictate notes'}
        className={cn('absolute bottom-2 right-2 inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors', voice.recording ? 'bg-red-100 text-red-700' : 'bg-brand-50 text-brand-700 hover:bg-brand-100')}
      >
        {voice.busy ? <Spinner className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      {voice.recording && <span className="sr-only" role="status">Listening: {voice.interim}</span>}
    </div>
  );
}

/**
 * How the call went, in the admin's own words.
 *
 * Never a list written here: an outcome added in Settings has to be offered
 * the same afternoon, and one the server would refuse must never be on screen.
 * `outcomeCard` gives each a hint, and an outcome nobody has described still
 * gets a card — a rep who cannot record what happened is the worse failure.
 */
function Outcomes({ deck }: { deck: CallDeckState }): JSX.Element {
  return (
    <label className="relative min-w-0 flex-1">
      <span className="sr-only">Call disposition</span>
      <PhoneCall className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-brand-700" aria-hidden />
      <select value={deck.outcome} onChange={(event) => deck.onOutcome(event.target.value)} aria-label="Call disposition" className="input h-9 appearance-none rounded-full bg-brand-50 py-1 pl-8 pr-8 text-xs font-semibold text-brand-800 dark:bg-brand-950/50 dark:text-brand-100">
        {deck.outcomes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-brand-700" aria-hidden />
    </label>
  );
}

/**
 * When to chase them, in one tap.
 *
 * The chip above says what will happen, and it is printed from the same value
 * the save reads — so a chip promising tomorrow and a date landing next week
 * is not expressible. Untouched, the outcome decides, which is the behaviour
 * that was already there.
 */
function Chase({ deck }: { deck: CallDeckState }): JSX.Element {
  const choices = quickFollowUpDates();
  const chosen = choices.find((c) => c.value === deck.followUp);
  const fromOutcome = outcomeCard(deck.outcome).followUpInHours;
  return (
    <Dropdown align="right" className="w-56" trigger={(
      <button type="button" aria-label="Choose next follow-up" className="inline-flex h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate"><CalendarDays className="h-3.5 w-3.5 shrink-0" />{chosen?.label ?? (deck.followUp ? 'Custom date' : fromOutcome ? 'Auto follow-up' : 'No follow-up')}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>
    )}>
      {(close) => <>
        {choices.map((choice) => <DropdownItem key={choice.value} onClick={() => { deck.onFollowUp(choice.value); close(); }}>{choice.label}</DropdownItem>)}
        <div className="border-t border-[var(--border)] p-2">
          <label className="block text-xs font-semibold text-muted">
            Custom date
            <input type="date" value={deck.followUp ?? ''} onChange={(event) => { deck.onFollowUp(event.target.value || null); if (event.target.value) close(); }} aria-label="Custom follow-up date" className="input mt-1 h-9 text-sm" />
          </label>
          {deck.followUp && <button type="button" onClick={() => { deck.onFollowUp(null); close(); }} className="mt-2 text-xs font-semibold text-muted hover:text-[var(--text)]">Clear selection</button>}
        </div>
      </>}
    </Dropdown>
  );
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
        title="Save this call and close the deck"
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
          title={`Save this call and ring ${deck.nextLabel}`}
          className="btn-primary btn-sm shrink-0"
        >
          Save &amp; Next →
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
