/**
 * The call deck, drawn once for the whole CRM.
 *
 * Mounted by the app's shell, so it stays on screen whatever page the rep
 * moves to until the call is saved (26 September 2026, the owner). Everything
 * a call needs to be finished lives here: the outcome, Save & Exit and
 * Save & Next, and the live controls — which follow what the phone reports,
 * so a tap on the handset shows here within a second.
 *
 * The record the call is about comes from `useLiveCall`, not from whichever
 * page is open, so saving from the Calls page or the dashboard writes to the
 * right person.
 */
import { type JSX, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type LiveCallState } from '../lib/api';
import { useLiveCall } from '../lib/liveCall';
import { useCallDispositions } from '../lib/callDispositions';
import { deckStatus, followUpFor, minutesFrom, type PhoneCallReport } from '../lib/callConsole';
import { getSocket } from '../lib/realtime';
import { toast } from '../lib/store';
import { CallDeck } from './CallDeck';

/** The id a record header gives the spot it wants the deck in. */
export const CALL_DECK_DOCK_ID = 'call-deck-dock';

const NOT_THE_CALLING_APP =
  'On the phone, open iPropy → This phone → "Control calls from the CRM" to switch these from here.';

export function LiveCallDeck(): JSX.Element | null {
  const call = useLiveCall((state) => state.call);
  if (!call) return null;
  return createPortal(<Deck />, document.body);
}

function Deck(): JSX.Element | null {
  const call = useLiveCall((state) => state.call)!;
  const { update, finish } = useLiveCall.getState();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const outcomes = useCallDispositions();
  const outcome = call.outcome && outcomes.includes(call.outcome)
    ? call.outcome
    : (outcomes.includes('Call Back Later') ? 'Call Back Later' : outcomes[0] ?? 'Call Back Later');
  const [saving, setSaving] = useState(false);
  const report = usePhoneReport();
  const now = useTick(1000);
  const status = deckStatus(report, call, now);
  const dock = useDock();

  // Who the call is with, and who is next in the list it was started from.
  const { data: record } = useQuery({
    queryKey: ['record', call.module, call.recordId],
    queryFn: () => api.record(call.module, call.recordId),
  });
  const { data: neighbours } = useQuery({
    queryKey: ['call-next', call.module, call.recordId],
    queryFn: () => api.neighbours(call.module, call.recordId),
    staleTime: 60_000,
  });
  const nextId = neighbours?.nextId ?? null;
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
      });
      // The outcome chases them for you, and never argues with a date somebody already chose.
      const chaseOn = followUpFor(outcome, (record?.values?.[call.followUpField] as string | null | undefined) ?? null, new Date());
      if (chaseOn) await api.update(call.module, call.recordId, { [call.followUpField]: chaseOn });

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
      // Next: open that record and ask it to ring, the way the list works everywhere.
      if (goTo) navigate(`/${module}/${goTo}?dial=1`);
    } catch (err) {
      toast.error('Could not log the call', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <CallDeck
      status={status.label}
      talking={status.ticking && report?.state === 'active'}
      speakerOn={speakerOn}
      muted={muted}
      held={held}
      canControl={Boolean(report?.canControlCall) && live}
      noControlReason={report?.canControlCall ? 'Only while the call is up.' : NOT_THE_CALLING_APP}
      onControl={(action, on) => void control(action, on)}
      canEndCall={Boolean(report?.canEndCall) && report?.state !== 'ended'}
      onHangUp={() => void hangUp()}
      position={neighbours?.position ?? null}
      total={neighbours?.total ?? null}
      who={who}
      outcomes={outcomes}
      outcome={outcome}
      onOutcome={(value) => update({ outcome: value })}
      saving={saving}
      nextLabel={nextLabel}
      onSave={(andNext) => void save(andNext)}
      dock={dock}
    />
  );
}

/**
 * What the phone last said about its call, kept current.
 *
 * Read on arrival and every two seconds, and pushed over the socket the
 * moment the phone reports — the poll is the net under the socket, which a
 * laptop lid or a flaky Wi-Fi drops without saying so.
 */
function usePhoneReport(): (PhoneCallReport & LiveCallState) | null {
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

/**
 * Where the open record's header wants the deck, if one is on screen.
 *
 * The header draws an empty placeholder; the deck sits over it, pinned to the
 * window, and follows it as the page scrolls or the window resizes. On a page
 * with no header to dock in, the deck keeps to the top-right corner.
 */
function useDock(): { top: number; left: number } | null {
  const location = useLocation();
  const [dock, setDock] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    let frame = 0;
    const measure = (): void => {
      const slot = document.getElementById(CALL_DECK_DOCK_ID);
      const rect = slot?.getBoundingClientRect();
      setDock((current) => {
        const next = rect ? { top: Math.round(rect.top), left: Math.round(rect.right - 368) } : null;
        if (current?.top === next?.top && current?.left === next?.left) return current;
        return next;
      });
    };
    const soon = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    // The header mounts after navigation and moves with scrolling; both re-measure.
    const watcher = new MutationObserver(soon);
    watcher.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, true);
    return () => {
      cancelAnimationFrame(frame);
      watcher.disconnect();
      window.removeEventListener('resize', soon);
      window.removeEventListener('scroll', soon, true);
    };
  }, [location.pathname, location.search]);
  return dock;
}
