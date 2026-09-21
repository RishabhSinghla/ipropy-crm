/**
 * The call console: everything a rep does between dialling and the next call,
 * on one screen.
 *
 * **21 September 2026, the owner, with a design of his own:** a live-call
 * header, one-tap outcome cards, the record's key values editable in place, a
 * WhatsApp follow-up ready to go, notes with an intent chip, and Save & Dial
 * Next at the end of it. It replaces a dialog that asked for an outcome, a
 * duration and a date.
 *
 * Three rules it is built on, each of which is a promise this CRM has broken
 * before:
 *
 * * **No screen names a field.** The values in the header and the sub-bar are
 *   whatever Admin → Split View says the header shows, through the same
 *   `useRecordPanes` the record page and the chat pane read. A copy would
 *   drift, and the way it drifts is that one screen learns about a new setting
 *   and the others do not.
 * * **Nothing is offered that cannot happen.** Mute, hold and End are drawn
 *   because the design asks for them and are **disabled with the reason on
 *   them**: Android only lets the handset's own dialler touch a call that is
 *   already running. A red End button that ends nothing is the exact failure
 *   this repo keeps writing down. They light up on their own the day the app
 *   can (`mayControlLiveCall`).
 * * **The timer counts what it can honestly count** — the time since Call was
 *   pressed, not the time the two people have been talking, which no browser
 *   can know.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import {
  BellOff, Check, Clock, Copy, Mic, Pause, PhoneOff, Send, Square, ThumbsUp,
  UserX, XCircle,
} from 'lucide-react';
import type { FieldMeta, RecordEnvelope } from '@ipropy/shared';
import { useApp, toast } from '../lib/store';
import { cn } from '../lib/utils';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import {
  elapsedLabel, INTENTS, type Intent, mayControlLiveCall, NO_LIVE_CONTROL_REASON, outcomeCard,
} from '../lib/callConsole';
import { Avatar, Spinner } from './ui';
import { EditableField } from './EditableField';
import { StrengthRing } from './StrengthRing';

const ICONS = {
  up: ThumbsUp, clock: Clock, noring: BellOff, unreachable: PhoneOff, drop: UserX, invalid: XCircle,
} as const;

const INTENT_LOOK: Record<Intent, string> = {
  hot: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  warm: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  cold: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
};

/** The seconds ticking in the header, restarted whenever a new call begins. */
function useElapsed(startedAt: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return elapsedLabel(startedAt ? Date.now() - startedAt : 0);
}

export interface CallConsoleProps {
  module: DescribedModule | undefined;
  record: RecordEnvelope | undefined;
  recordLabel: string;
  moduleName: string;
  recordId: string;
  number: string;
  startedAt: number | null;
  placing: boolean;
  /** Outcomes from the admin's own picklist. */
  outcomes: string[];
  selected: string;
  onSelect: (value: string) => void;
  notes: string;
  onNotes: (value: string) => void;
  intent: Intent | null;
  onIntent: (value: Intent | null) => void;
  whatsAppOn: boolean;
  onWhatsApp: (on: boolean) => void;
  whatsAppPreview: { text: string; ready: boolean; reason?: string } | null;
  savedAgo: string | null;
  nextLabel: string | null;
  saving: boolean;
  voice: {
    supported: boolean; recording: boolean; busy: boolean; toggle: () => void;
  };
  onClose: () => void;
  onSave: (andDialNext: boolean) => void;
  onSkipNext: () => void;
}

export function CallConsole(props: CallConsoleProps): JSX.Element {
  const {
    module, record, recordLabel, moduleName, recordId, number, startedAt, placing,
    outcomes, selected, onSelect, notes, onNotes, intent, onIntent,
    whatsAppOn, onWhatsApp, whatsAppPreview, savedAgo, nextLabel, saving, voice,
    onClose, onSave, onSkipNext,
  } = props;

  const me = useApp((st) => st.user);
  const timer = useElapsed(startedAt);
  const liveControls = mayControlLiveCall(undefined);
  // Whichever of the admin's own outcomes means "not a buyer", so the
  // shortcut cannot name one this CRM no longer offers.
  const disqualifyingOutcome = useMemo(
    () => outcomes.find((value) => outcomeCard(value).disqualifies) ?? null,
    [outcomes],
  );

  return (
    <div className="flex flex-col">
      <ConsoleHeader
        module={module}
        record={record}
        recordLabel={recordLabel}
        number={number}
        agent={me?.fullName ?? ''}
        timer={timer}
        placing={placing}
        liveControls={liveControls}
      />

      <KeyValueBar
        module={module}
        record={record}
        moduleName={moduleName}
        recordId={recordId}
        savedAgo={savedAgo}
      />

      <div className="space-y-4 px-5 py-4">
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wide text-muted">
              <Check className="h-3.5 w-3.5" /> Call disposition outcome
            </p>
            <p className="text-2xs text-muted">Select outcome to update lead pipeline</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {outcomes.map((value) => {
              const card = outcomeCard(value);
              const Icon = ICONS[card.icon];
              const on = selected === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  /* The outcome itself is the name. Without this the chip in
                     the corner reads first — "Priority Interested High
                     priority buyer" — which is what a screen reader announces
                     and what a test has to guess at. */
                  aria-label={value}
                  onClick={() => onSelect(value)}
                  className={cn(
                    'relative rounded-xl border p-3 text-left transition-colors',
                    on
                      ? 'border-emerald-500 bg-emerald-50/70 ring-1 ring-emerald-500 dark:bg-emerald-950/40'
                      : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <Icon className={cn('h-4 w-4', on ? 'text-emerald-600' : 'text-slate-400')} />
                    {card.chip && (
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-muted">{card.chip}</span>
                    )}
                    {on && <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-emerald-600" />}
                  </div>
                  <p className="mt-2 truncate text-sm font-semibold">{value}</p>
                  <p className="truncate text-2xs text-muted">{card.hint}</p>
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {/*
              The shortcut from the design. It selects the outcome rather than
              writing anything — the record changes when Save is pressed, like
              everything else on this screen.
            */}
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-2xs font-semibold text-negative hover:underline"
              onClick={() => onSelect(disqualifyingOutcome ?? selected)}
              disabled={!disqualifyingOutcome}
            >
              <UserX className="h-3.5 w-3.5" /> Mark disqualified / not interested
            </button>
            <p className="text-2xs text-muted">
              Saving writes the outcome to this record and schedules the follow-up its card names.
            </p>
          </div>
        </section>

        <div className="grid gap-3 lg:grid-cols-2">
          {/*
            Only when a WhatsApp provider is actually connected and this
            template can be filled for this person. An "off" switch beside a
            preview that could never send is the shape of promise this CRM has
            broken before.
          */}
          {whatsAppPreview && (
            <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wide text-muted">
                  <Send className="h-3.5 w-3.5" /> WhatsApp follow-up
                </p>
                <label className="flex items-center gap-1.5 text-2xs font-semibold">
                  <input
                    type="checkbox"
                    checked={whatsAppOn}
                    disabled={!whatsAppPreview.ready}
                    onChange={(e) => onWhatsApp(e.target.checked)}
                  />
                  Send on save
                </label>
              </div>
              <div className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/60 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                <p className="text-2xs font-semibold text-muted">Message preview</p>
                <p className="mt-1 whitespace-pre-wrap text-sm italic">{whatsAppPreview.text}</p>
              </div>
              <p className={cn('mt-2 text-2xs', whatsAppPreview.ready ? 'text-positive' : 'text-amber-700 dark:text-amber-400')}>
                {whatsAppPreview.ready ? 'Template ready' : whatsAppPreview.reason}
              </p>
            </section>
          )}

          <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-2xs font-bold uppercase tracking-wide text-muted">Call notes &amp; intent</p>
              <div className="flex gap-1">
                {INTENTS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={intent === value}
                    onClick={() => onIntent(intent === value ? null : value)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-2xs font-semibold capitalize transition-colors',
                      intent === value ? INTENT_LOOK[value] : 'border-slate-200 text-muted dark:border-slate-700',
                    )}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              id="call-notes"
              className="input mt-2"
              rows={4}
              value={notes}
              onChange={(e) => onNotes(e.target.value)}
              placeholder="What happened on the call?"
            />

            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-2xs text-muted">{savedAgo ? `Draft saved ${savedAgo}` : 'Not saved yet'}</p>
              <button
                type="button"
                className={cn('btn-ghost btn-sm', voice.recording && 'text-red-600')}
                onClick={voice.toggle}
                disabled={!voice.supported || voice.busy}
                title={voice.recording ? 'Stop dictation' : 'Speak the note'}
              >
                {voice.busy ? <Spinner className="h-3.5 w-3.5" />
                  : voice.recording ? <Square className="h-3.5 w-3.5 fill-current" />
                    : <Mic className="h-3.5 w-3.5" />}
                {voice.recording ? 'Stop' : voice.busy ? 'Writing…' : 'Voice to text'}
              </button>
            </div>
          </section>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/60">
        <p className="flex items-center gap-2 text-2xs text-muted">
          {nextLabel ? (
            <>
              <span>Next: <strong className="text-slate-700 dark:text-slate-200">{nextLabel}</strong></span>
              <button type="button" className="btn-ghost btn-sm" onClick={onSkipNext}>Skip</button>
            </>
          ) : 'Last one in this list'}
        </p>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Close</button>
          <button className="btn-primary" disabled={saving} onClick={() => onSave(Boolean(nextLabel))}>
            {saving && <Spinner className="h-3.5 w-3.5" />}
            {nextLabel ? 'Save & dial next' : 'Save call'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConsoleHeader({
  module, record, recordLabel, number, agent, timer, placing, liveControls,
}: {
  module: DescribedModule | undefined;
  record: RecordEnvelope | undefined;
  recordLabel: string;
  number: string;
  agent: string;
  timer: string;
  placing: boolean;
  liveControls: boolean;
}): JSX.Element {
  const copy = (): void => {
    void navigator.clipboard?.writeText(number).then(
      () => toast.info('Number copied'),
      () => toast.error('Could not copy', 'Your browser would not allow it.'),
    );
  };

  return (
    <div className="bg-slate-900 px-5 py-3.5 text-white">
      <div className="flex flex-wrap items-center gap-3">
        {module && record ? (
          <StrengthRing fields={module.fields} values={record.values} size={34} cornerBadge>
            <Avatar name={recordLabel} size={34} />
          </StrengthRing>
        ) : (
          <Avatar name={recordLabel} size={34} />
        )}

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-base font-semibold">{recordLabel}</p>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-2xs font-bold uppercase text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {placing ? 'Dialling' : 'On call'}
            </span>
            {agent && (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-2xs text-slate-200">Agent: {agent}</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-2xs text-slate-300">
            <span className="tabular-nums">{number}</span>
            <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-slate-300 hover:text-white">
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-lg bg-white/10 px-2.5 py-1 text-sm font-semibold tabular-nums" title="Time since you pressed Call">
            {timer}
          </span>
          {/*
            Drawn because the design asks for them, disabled because Android
            only lets the handset's own dialler touch a running call. The title
            says so rather than leaving a rep pressing a dead button.
          */}
          <ControlButton label="Mute" enabled={liveControls}><Mic className="h-4 w-4" /></ControlButton>
          <ControlButton label="Hold" enabled={liveControls}><Pause className="h-4 w-4" /></ControlButton>
          <ControlButton label="End call" enabled={liveControls} danger><PhoneOff className="h-4 w-4" /></ControlButton>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  label, enabled, danger, children,
}: { label: string; enabled: boolean; danger?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <button
      type="button"
      disabled={!enabled}
      title={enabled ? label : `${label} — ${NO_LIVE_CONTROL_REASON}`}
      aria-label={enabled ? label : `${label}, unavailable. ${NO_LIVE_CONTROL_REASON}`}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
        danger ? 'bg-red-500/80 text-white' : 'bg-white/10 text-slate-200',
        enabled ? 'hover:bg-white/20' : 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/**
 * The record's own key values, editable where they stand.
 *
 * The fields are the ones Admin → Split View already chose for this module's
 * header — so an admin who decides Budget matters more than Locality changes
 * it in one place and every screen agrees, this one included.
 */
function KeyValueBar({
  module, record, moduleName, recordId, savedAgo,
}: {
  module: DescribedModule | undefined;
  record: RecordEnvelope | undefined;
  moduleName: string;
  recordId: string;
  savedAgo: string | null;
}): JSX.Element | null {
  const panes = useRecordPanes(module ?? ({ name: moduleName, fields: [], layouts: [], permissions: {} } as unknown as DescribedModule));
  const fields = useMemo<FieldMeta[]>(() => panes.headerFields.slice(0, 6), [panes.headerFields]);

  if (!module || !record || !fields.length) return null;
  const canEdit = record.can?.edit ?? module.permissions.edit;

  return (
    <div
      data-testid="call-key-values"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50 px-5 py-2 dark:border-slate-800 dark:bg-slate-900/60"
    >
      {fields.map((field) => (
        <span key={field.name} className="flex min-w-0 items-center gap-1.5 text-2xs">
          <span className="shrink-0 text-muted">{field.label}:</span>
          {canEdit ? (
            <EditableField
              surface="record"
              module={moduleName}
              recordId={recordId}
              field={field}
              value={record.values[field.name]}
              display={record.display?.[field.name]}
              siblings={record.values}
              compact
            />
          ) : (
            <span className="truncate font-medium">{String(record.display?.[field.name] ?? record.values[field.name] ?? '—')}</span>
          )}
        </span>
      ))}
      <span className="ml-auto shrink-0 text-2xs text-positive">
        {savedAgo ? `Autosave on · ${savedAgo}` : 'Autosave on'}
      </span>
    </div>
  );
}
