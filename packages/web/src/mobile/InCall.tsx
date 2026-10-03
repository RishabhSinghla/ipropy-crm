/**
 * The call screen — the prototype's third, and the one that needs the phone's
 * permission to be real.
 *
 * Who is on the call, the clock, the lead's own dossier underneath, the five
 * controls, a quick note, and End.
 *
 * **It reads the same live call the rest of the CRM reads** (`useLiveCall`).
 * The floating bar on a laptop, the call deck in the record's right pane and
 * this screen are three renderings of one state — a second copy would drift,
 * and the way it drifts is that one of them learns a new rule about the chase
 * date and the others do not, so the same call saves differently depending on
 * which screen the rep happened to be looking at.
 *
 * ## What is real, and what Android will not allow
 *
 * **Mute, speaker and hold only work when iPropy is the phone's default
 * calling app.** Android hands those to the calling app and to nobody else —
 * there is no permission that buys them separately. So this screen asks
 * `callControlState()` what this handset can actually do and draws the
 * controls accordingly: live when they work, visibly off with the reason in
 * their tooltip when they do not, and never a button that looks alive and
 * silently does nothing. That failure mode is one this repo has written down
 * twice and will not ship a third time.
 *
 * **End is different and cheaper.** `TelecomManager.endCall()` needs
 * `ANSWER_PHONE_CALLS` alone, so a rep can hang up from here without handing
 * over their phone app at all.
 */
import { type JSX, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Grid3x3, Mic, MicOff, Pause, PhoneOff, UserPlus, Volume2,
} from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { toast } from '../lib/store';
import { useLiveCall } from '../lib/liveCall';
import {
  askToControlCalls, callControlState, callSyncSupported, endCallOnPhone, performCallAction,
} from '../lib/callSync';
import { Avatar } from './primitives';

/** `02:49`, counting from when Call was pressed — the only clock this screen can honestly keep. */
function Clock({ since }: { since: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1_000));
  const text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return <span className="text-lg font-semibold tabular-nums text-[#15803d]">{text}</span>;
}

/**
 * One of the five round controls.
 *
 * `live` is what this handset can actually do, not what the design draws. A
 * dead control still appears — the prototype has five and a row of three reads
 * as a broken screen — but it says why in its tooltip and cannot be pressed.
 */
function Control({ label, icon, live, on, reason, onPress }: {
  label: string;
  icon: JSX.Element;
  live: boolean;
  on?: boolean;
  reason: string;
  onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={!live}
      aria-pressed={live ? Boolean(on) : undefined}
      title={live ? label : reason}
      onClick={onPress}
      className="flex min-w-0 flex-1 flex-col items-center gap-1.5 disabled:opacity-40"
    >
      <span className={cn(
        'flex h-14 w-14 items-center justify-center rounded-full border transition-colors',
        on
          ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
          : 'border-[var(--border)] bg-white text-slate-700 dark:bg-slate-900 dark:text-slate-200',
      )}
      >
        {icon}
      </span>
      <span className="truncate text-[11px] font-medium text-slate-600 dark:text-slate-300">{label}</span>
    </button>
  );
}

export default function MobileInCall(): JSX.Element | null {
  const navigate = useNavigate();
  const call = useLiveCall((state) => state.call);
  const update = useLiveCall((state) => state.update);

  const [note, setNote] = useState('');
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [held, setHeld] = useState(false);
  const [can, setCan] = useState({ canEndCall: false, canControlCall: false });
  const [params] = useSearchParams();

  useEffect(() => { void callControlState().then(setCan); }, []);

  /*
    The record the call is about, so the dossier underneath is this CRM's own
    facts rather than anything typed into this screen. It is the ordinary
    record read, so a rep who may not open the lead is not shown its budget
    here either — the permission lives in one place, as everywhere else.
  */
  const { data: record } = useQuery({
    queryKey: ['record', call?.module, call?.recordId],
    queryFn: () => api.record(call!.module, call!.recordId),
    enabled: Boolean(call?.module && call?.recordId),
  });

  /*
    **Two kinds of call reach this screen, and only one of them has a record.**

    A contact rung from the keypad opens their own record and the deck there;
    a number nobody in the CRM owns has no record to open, so it arrives here
    with `?to=` and nothing else. Without this the screen drew nothing at all
    for exactly the call a dialler exists to make.

    `number` is the only fact the second kind carries. Everything below that
    needs a record — the dossier, the note, the record link — is drawn only
    when there is one.
  */
  const number = call?.number ?? params.get('to') ?? '';
  if (!call && !number) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--app-bg)] px-8 text-center text-sm text-muted">
        No call is running. Dial somebody from the keypad.
      </div>
    );
  }

  const act = async (action: string, next: boolean, apply: (on: boolean) => void): Promise<void> => {
    const result = await performCallAction(action, next, call?.recordId ?? '');
    if (!result.done) { toast.error(`Could not ${action} this call`, result.reason); return; }
    apply(next);
  };

  const hangUp = async (): Promise<void> => {
    const result = await endCallOnPhone(call?.recordId ?? '');
    /*
      The call is still saved either way. A rep who hangs up with the handset
      rather than this button must not lose the note and the outcome they have
      just typed — so a refusal here says so and leaves the deck standing,
      rather than treating "could not end it" as "there is no call".
    */
    if (!result.ended) toast.info('End the call on your phone', result.reason);
    navigate(call ? `/${call.module}/${call.recordId}` : '/recents');
  };

  const reason = callSyncSupported
    ? 'Make iPropy your phone app to use this'
    : 'Only on an Android phone with the iPropy app';

  const label = String(record?.label ?? number);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--app-bg)] px-4 pb-6" data-testid="mobile-in-call">
      {/* Who, and for how long. */}
      <div className="flex shrink-0 flex-col items-center pt-8 text-center">
        <span className="rounded-full border border-[var(--border)] bg-white px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600 shadow-2xs dark:bg-slate-900 dark:text-slate-300">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#16a34a]" />
          {call?.placing ? 'Calling…' : 'Active call'}
        </span>
        <span className="mt-5"><Avatar name={label} size={96} /></span>
        <h1 className="mt-4 max-w-full truncate text-2xl font-bold text-slate-900 dark:text-white">{label}</h1>
        {/* Only when it says something the heading does not. With no record
            the heading *is* the number, and printing it twice an inch apart is
            the duplication this CRM keeps trimming off its own headers. */}
        {label !== number && <p className="mt-1 text-sm tabular-nums text-slate-500">{number}</p>}
        <p className="mt-1"><Clock since={call?.pressedAt ?? Date.now()} /></p>
      </div>

      {/* The lead's own dossier, straight off the record. */}
      {record && call && (
        <button
          type="button"
          onClick={() => navigate(`/${call.module}/${call.recordId}`)}
          className="mt-5 w-full rounded-2xl border border-[var(--border)] bg-white p-4 text-left shadow-2xs dark:bg-slate-900"
        >
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Open the full record
          </span>
          <span className="mt-1 block truncate text-sm font-semibold text-slate-900 dark:text-white">{label}</span>
        </button>
      )}

      {/* The five. */}
      <div className="mt-6 flex items-start gap-2">
        <Control
          label="Mute" live={can.canControlCall} on={muted} reason={reason}
          icon={muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          onPress={() => void act('mute', !muted, setMuted)}
        />
        <Control
          label="Keypad" live reason={reason}
          icon={<Grid3x3 className="h-5 w-5" />}
          onPress={() => navigate('/dialer')}
        />
        <Control
          label="Speaker" live={can.canControlCall} on={speaker} reason={reason}
          icon={<Volume2 className="h-5 w-5" />}
          onPress={() => void act('speaker', !speaker, setSpeaker)}
        />
        <Control
          label="Add" live={false} reason="Android does not let an app add somebody to a call"
          icon={<UserPlus className="h-5 w-5" />}
          onPress={() => undefined}
        />
        <Control
          label="Hold" live={can.canControlCall} on={held} reason={reason}
          icon={<Pause className="h-5 w-5" />}
          onPress={() => void act('hold', !held, setHeld)}
        />
      </div>

      {/* The note is saved *with the call*, so it is offered only where there
          is a call to save it with. A number nobody owns has nowhere to put
          one until the call log syncs and finds its contact. */}
      {call && (
      <div className="mt-5 rounded-2xl border border-[var(--border)] bg-white p-3 shadow-2xs dark:bg-slate-900">
        <label htmlFor="in-call-note" className="sr-only">Quick note about this call</label>
        <textarea
          id="in-call-note"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Quick log: e.g. wants Sector 57 corner…"
          className="w-full resize-none border-none bg-transparent text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-0 dark:text-slate-100"
        />
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!note.trim()}
            /*
              Saved on to the live call rather than posted now. The outcome and
              the chase date are chosen when the call ends, and `logCall` writes
              all three together — writing the note separately would make a call
              with no outcome, which every report then has to explain away.
            */
            onClick={() => { update({ notes: note }); toast.success('Saved with this call'); }}
            className="rounded-full bg-[#eef2ff] px-4 py-1.5 text-xs font-semibold text-[#2563eb] disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
      )}

      {/* Making this phone's calling app iPropy — the one thing that turns the
          three dead controls above into live ones. Offered only where it would
          change something. */}
      {callSyncSupported && !can.canControlCall && (
        <button
          type="button"
          onClick={() => void askToControlCalls().then((answer) => setCan((current) => ({ ...current, canControlCall: answer.canControlCall })))}
          className="mt-4 rounded-2xl border border-[#93c5fd] bg-[#eff6ff] p-3 text-left text-xs text-[#1d4ed8]"
        >
          <span className="block font-semibold">Use iPropy as your phone app</span>
          <span className="mt-0.5 block">
            Mute, speaker and hold only work for the phone’s own calling app. Android asks you, and
            you can hand it back any time in Settings.
          </span>
        </button>
      )}

      <button
        type="button"
        onClick={() => void hangUp()}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-[#dc2626] py-4 text-base font-bold text-white shadow-lg"
      >
        <PhoneOff className="h-5 w-5" />
        End call
      </button>

      {/* The way out that keeps the call running, for a rep who wants to look
          something up mid-conversation. `finish()` is deliberately not here:
          that would throw away the note and the outcome. */}
      {call && (
        <button
          type="button"
          onClick={() => navigate(`/${call.module}/${call.recordId}`)}
          className="mt-3 w-full py-2 text-center text-xs font-semibold text-slate-500"
        >
          Keep the call and open the record
        </button>
      )}
    </div>
  );
}
