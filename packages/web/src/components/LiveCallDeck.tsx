/**
 * The shell keeps a compact route back to the active call. The working deck
 * lives in that record's notes pane; leaving it never loses an unsaved draft.
 */
import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, type LiveCallState } from '../lib/api';
import { useLiveCall } from '../lib/liveCall';
import { useCallDispositionOptions } from '../lib/callDispositions';
import { saveNextUrl } from '../lib/saveNextUrl';
import {
  callBar, deckStatus, followUpFor, minutesFrom, type CallBar, type PhoneCallReport,
} from '../lib/callConsole';
import { getSocket } from '../lib/realtime';
import { toast } from '../lib/store';
import { useApp } from '../lib/store';

const NOT_THE_CALLING_APP =
  'On the phone, open iPropy → This phone → "Control calls from the CRM" to switch these from here.';

export function returnToCallUrl(call: { queueUrl?: string | null; module: string; recordId: string }): string {
  const target = new URL(call.queueUrl || `/${encodeURIComponent(call.module)}`, 'https://crm.local');
  target.searchParams.set('open', call.recordId);
  target.searchParams.delete('dial');
  return `${target.pathname}${target.search}`;
}

export function LiveCallDeck(): JSX.Element | null {
  const call = useLiveCall((state) => state.call);
  const inPane = useLiveCall((state) => state.inPane);
  const userId = useApp((state) => state.user?.id ?? null);
  useEffect(() => {
    if (call && userId && call.userId !== userId) useLiveCall.getState().finish();
  }, [call, userId]);
  if (!call || !userId || call.userId !== userId || inPane) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-900 dark:border-brand-900 dark:bg-brand-950/60 dark:text-brand-100" role="status">
      <span className="truncate">Call in progress · {call.number}{call.notes?.trim() ? ' · Notes saved as draft' : ''}</span>
      <Link className="shrink-0 rounded-full bg-brand-600 px-3 py-1.5 font-semibold text-white hover:bg-brand-700" to={returnToCallUrl(call)}>
        Return to call
      </Link>
    </div>
  );
}

/** Everything a live call needs to be worked and finished. */
export interface CallDeckState {
  status: string;
  /**
   * The bar and the clock the panel draws in place of the status words.
   *
   * The floating bar keeps `status`: one line has room for a phrase and not
   * for a bar. Both come from the same report, so they cannot disagree.
   */
  bar: CallBar;
  talking: boolean;
  speakerOn: boolean; muted: boolean; held: boolean;
  canControl: boolean; noControlReason: string;
  onControl: (action: 'speaker' | 'mute' | 'hold', on: boolean) => void;
  canEndCall: boolean; onHangUp: () => void;
  position: number | null; total: number | null;
  who: string;
  /* Value and label together: the logger writes a stable value while a rep
     must always read the name their admin typed. */
  outcomes: { value: string; label: string }[];
  outcome: string;
  onOutcome: (value: string) => void;
  /** Current CRM date, so the call-deck button reflects the record before edits. */
  existingFollowUp: string | null;
  /**
   * The chase date this call leaves behind, as a local day.
   *
   * Three states, not two: `undefined` is "let the outcome decide", which is
   * what the CRM has always done, `null` is "chase nobody" said on purpose, and
   * a day is a day. Collapsing the first two made "No follow-up" unsayable.
   */
  followUp: string | null | undefined;
  onFollowUp: (day: string | null | undefined) => void;
  saving: boolean;
  nextLabel: string | null;
  onSave: (andDialNext: boolean) => void;
  /** The one way out that forgets the call — nobody was spoken to. */
  onDiscard: () => void;
}

/** The state and actions for the in-record call panel. Only call with a live call. */
export function useCallDeckState(): CallDeckState {
  const call = useLiveCall((state) => state.call)!;
  const { update, finish } = useLiveCall.getState();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const outcomes = useCallDispositionOptions();
  const outcome = call.outcome && outcomes.some((option) => option.value === call.outcome)
    ? call.outcome
    : (outcomes.some((option) => option.value === 'Call Back Later') ? 'Call Back Later' : outcomes[0]?.value ?? 'Call Back Later');
  const [saving, setSaving] = useState(false);
  const notes = call.notes ?? '';
  const chaseOverride = call.chaseOverride;
  const report = usePhoneReport();
  const now = useTick(1000);
  const status = deckStatus(report, call, now);
  const bar = callBar(report, call, now);

  // Who the call is with, and who is next in the list it was started from.
  const { data: record } = useQuery({
    queryKey: ['record', call.module, call.recordId],
    queryFn: () => api.record(call.module, call.recordId),
  });
  const { data: fallbackNeighbours } = useQuery({
    queryKey: ['call-next', call.module, call.recordId],
    queryFn: () => api.neighbours(call.module, call.recordId),
    enabled: call.queueNextId === undefined,
    staleTime: 60_000,
  });
  const nextId = call.queueNextId !== undefined ? call.queueNextId : fallbackNeighbours?.nextId ?? null;
  const { data: nextRecord } = useQuery({
    queryKey: ['record', call.module, nextId],
    queryFn: () => api.record(call.module, nextId!),
    enabled: Boolean(nextId),
  });
  const who = String(record?.label ?? call.number);
  const nextLabel = nextRecord ? String(nextRecord.label ?? 'the next record') : null;

  /*
    A click here changes what the phone does, and the phone's own report is
    the truth. Between the click and that report the button shows the new
    state, so it does not look ignored for a second; the report then wins.
  */
  const [asked, setAsked] = useState<Partial<Record<'speaker' | 'mute' | 'hold', boolean>>>({});
  useEffect(() => { setAsked({}); }, [report?.reportedAt]);
  const speakerOn = asked.speaker ?? Boolean(report?.speaker);
  const muted = asked.mute ?? Boolean(report?.muted);
  const held = asked.hold ?? report?.state === 'held';
  const live = report?.state === 'dialling' || report?.state === 'ringing' || report?.state === 'active' || report?.state === 'held';

  const control = async (action: 'speaker' | 'mute' | 'hold', on: boolean): Promise<void> => {
    setAsked((current) => ({ ...current, [action]: on }));
    try {
      const result = await api.callControlOnPhone(action, on);
      if (!result.sent) {
        setAsked((current) => ({ ...current, [action]: undefined }));
        toast.error('The phone cannot do that from here', result.detail ?? NOT_THE_CALLING_APP);
      }
    } catch (err) {
      setAsked((current) => ({ ...current, [action]: undefined }));
      toast.error('Could not reach the phone', (err as Error).message);
    }
  };

  const hangUp = async (): Promise<void> => {
    try {
      const result = await api.hangUpOnPhone({ module: call.module, recordId: call.recordId });
      if (result.sent) toast.info('Ending the call', `${result.device ?? 'Your phone'} is hanging up.`);
      else toast.error('Could not end it from here', result.detail ?? 'Use the red button on the handset.');
    } catch (err) {
      toast.error('Could not end it from here', (err as Error).message);
    }
  };

  const save = async (andDialNext: boolean): Promise<void> => {
    if (saving) return;
    setSaving(true);
    const goTo = andDialNext ? nextId : null;
    try {
      /*
        How long they talked: the phone's own figure when it reported one,
        which is exact; otherwise the old estimate from when Call was pressed.
        An outcome that means nobody answered is always zero.
      */
      const answered = !['No Answer', 'Busy', 'Switched Off', 'Not Reachable'].includes(outcome);
      const talked = report?.talkedSeconds
        ?? (report?.connectedAt ? Math.round((Date.now() - report.connectedAt) / 1000) : null);
      await api.logCall({
        to: call.number, recordId: call.recordId, module: call.module, direction: 'outbound',
        durationSeconds: !answered ? 0 : (talked ?? minutesFrom(call.pressedAt, Date.now(), 1) * 60),
        disposition: outcome,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      /*
        A date the rep picked on the panel wins — they were on the call. With
        nothing picked the outcome chases them for you, and still never argues
        with a date somebody has already put in the future.
      */
      const chaseOn = chaseOverride !== undefined
        ? chaseOverride
        : followUpFor(outcome, (record?.values?.[call.followUpField] as string | null | undefined) ?? null, new Date());
      if (chaseOn) await api.update(call.module, call.recordId, { [call.followUpField]: chaseOn });

      // Logging updates the current record's timestamp, which can move it in
      // the default Recently Updated sort. Refresh the saved neighbor's ordinal
      // after that write so the handoff page remains the page containing it.
      let nextPosition = call.queuePosition;
      if (goTo && call.queueUrl && call.queuePosition) {
        try {
          const source = new URL(call.queueUrl, window.location.origin);
          const params = source.searchParams;
          const refreshed = await api.neighbours(call.module, goTo, {
            ...(params.get('view') ? { view: params.get('view')! } : {}),
            ...(params.get('q') ? { search: params.get('q')! } : {}),
            ...(params.get('filter') ? { filter: params.get('filter')! } : {}),
            ...(params.get('sort') ? { sort: params.get('sort')! } : {}),
            ...(params.get('dir') ? { dir: params.get('dir')! } : {}),
          });
          if (refreshed.position) nextPosition = refreshed.position;
        } catch {
          // The captured queue position is a safe fallback during a transient
          // network error; a failed re-count must not discard a saved call.
        }
      }

      toast.success('Call logged', chaseOn ? 'Follow-up scheduled.' : 'One conversation moved forward.');
      const { module, recordId } = call;
      finish();
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['record-calls', recordId] }),
        queryClient.invalidateQueries({ queryKey: ['timeline', module, recordId] }),
        queryClient.invalidateQueries({ queryKey: ['record', module, recordId] }),
        queryClient.invalidateQueries({ queryKey: ['records', module] }),
        queryClient.invalidateQueries({ queryKey: ['calls'] }),
      ]);
      // Keep the exact view/filter/sort/page context captured when the rep
      // pressed Call. Recompute the destination page from the next row's
      // ordinal in that queue; a record id is not a page number.
      if (goTo) {
        /*
          An ordinary in-app move, never `window.location.assign`. That
          reloaded the whole CRM between one call and the next — sign-in,
          metadata, every chunk — which is what the owner reported on
          28 September 2026 as "the new window open in same window of entire
          CRM instead of Next record".

          The destination can be the same /leads route with a *different*
          filter, sort and page, and React Router keeps one ListView mounted
          across that — so the stamp below tells `ListRoute` in `App.tsx` to
          remount. That gives the clean hydration the reload was there for,
          and costs nothing.
        */
        navigate(saveNextUrl(call.queueUrl, module, goTo, nextPosition), {
          state: { callDeckHandoff: Date.now() },
        });
      }
    } catch (err) {
      toast.error('Could not log the call', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return {
    status: status.label,
    bar,
    talking: status.ticking && report?.state === 'active',
    speakerOn,
    muted,
    held,
    canControl: Boolean(report?.canControlCall) && live,
    noControlReason: report?.canControlCall ? 'Only while the call is up.' : NOT_THE_CALLING_APP,
    onControl: (action, on) => void control(action, on),
    canEndCall: Boolean(report?.canEndCall) && report?.state !== 'ended',
    onHangUp: () => void hangUp(),
    position: call.queuePosition ?? fallbackNeighbours?.position ?? null,
    total: call.queueTotal ?? fallbackNeighbours?.total ?? null,
    who,
    outcomes,
    outcome,
    onOutcome: (value) => update({ outcome: value }),
    existingFollowUp: (record?.values?.[call.followUpField] as string | null | undefined) ?? null,
    // Not `?? null`: absent means "let the outcome decide" and null means
    // "chase nobody", and collapsing them makes the second unsayable.
    followUp: chaseOverride,
    onFollowUp: (day) => update({ chaseOverride: day }),
    saving,
    nextLabel,
    onSave: (andNext) => void save(andNext),
    // Nobody was spoken to, so nothing is written — the one way out that
    // forgets, and the reason Save & Exit is not the only button.
    onDiscard: () => finish(),
  };
}

/**
 * What the phone last said about its call, kept current.
 *
 * Read on arrival and every two seconds, and pushed over the socket the
 * moment the phone reports — the poll is the net under the socket, which a
 * laptop lid or a flaky Wi-Fi drops without saying so.
 */
export function usePhoneReport(): (PhoneCallReport & LiveCallState) | null {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['live-call'],
    queryFn: async () => withClock(await api.liveCall()),
    refetchInterval: 2_000,
  });
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const onReport = (live: LiveCallState): void => { queryClient.setQueryData(['live-call'], withClock(live)); };
    socket.on('phone:call', onReport);
    return () => { socket.off('phone:call', onReport); };
  }, [queryClient]);
  return data ?? null;
}

/** The server's "seconds ago" turned into moments on this computer's clock. */
function withClock(live: LiveCallState): PhoneCallReport & LiveCallState {
  const now = Date.now();
  return {
    ...live,
    connectedAt: live.connectedSecondsAgo === null ? null : now - live.connectedSecondsAgo * 1000,
    reportedAt: live.updatedSecondsAgo === null ? null : now - live.updatedSecondsAgo * 1000,
  };
}

function useTick(every: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}
