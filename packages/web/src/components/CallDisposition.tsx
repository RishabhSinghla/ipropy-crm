import {
  createContext, type JSX, type ReactNode, useContext, useEffect, useRef, useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { api } from '../lib/api';
import { useCallDispositions } from '../lib/callDispositions';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { useChatRecord } from './ChatRecordPane';
import { type CallDeckProps } from './CallDeck';
import { followUpFor, minutesFrom } from '../lib/callConsole';
import { dial } from '../lib/nativeActions';
import { isNative } from '../lib/native';

interface CallActions {
  /**
   * The live call, ready to hand straight to `<CallDeck {...deck} />`, or null
   * when nobody is on a call.
   *
   * The deck is rendered by whichever header is on screen rather than by this
   * provider, which is the whole point of the change: the record stays
   * visible and editable while the call runs. The provider still owns the
   * call — one clock, one outcome, one save — so two headers cannot disagree
   * about what is happening.
   */
  deck: CallDeckProps | null;
  /**
   * Ring somebody, and open the console over the record.
   *
   * `from` is which handset places it, and the two are deliberately different
   * controls on screen (21 September 2026, the owner): the **Call icon** rings
   * the rep's Android phone, and **the number itself** hands off to whatever
   * this computer uses for `tel:` — a softphone on a Mac or a Windows machine.
   * One of those is a pocket; the other is a headset, and a rep wearing the
   * headset should not have to pick up the phone.
   */
  startCall: (number: string, from?: 'phone' | 'desk') => Promise<void>;
}

const CallDispositionContext = createContext<CallActions | null>(null);

/** Returns null outside a record page, where a normal tel: link is correct. */
export function useCallDisposition(): CallActions | null {
  return useContext(CallDispositionContext);
}

/**
 * Wait, briefly, for the phone to say it rang.
 *
 * Polled rather than pushed: the answer is one row and the wait is seconds, so
 * a socket subscription for it would be more moving parts than the thing it
 * reports. Five seconds is the budget — beyond that a rep has already reached
 * for their phone to see what happened.
 */
async function phoneTookIt(
  commandId: string | undefined,
): Promise<{ took: boolean; via: string | null }> {
  if (!commandId) return { took: false, via: null };
  /*
    `delivered` is the phone having collected the instruction, and that is
    already the answer to "did it reach the handset". Only `done` says what
    happened next, and that lands after the rep has taken the phone out of
    their pocket — which is longer than anybody will watch a laptop for.

    Waiting for `done` alone is how a call that rang perfectly well was
    reported as "not confirmed" on 20 September: the command was delivered
    inside a second, the customer was spoken to for a minute, and the desk had
    given up five seconds in. A phone that has the number is not a failure.
  */
  let collected = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    try {
      const { status, via } = await api.dialStatus(commandId);
      /*
        `via` and not just `status`, because the two ways a phone can take a
        dial are different for the rep. On the app path it is already ringing;
        on the dialler fallback the number is typed in and nothing happens
        until somebody presses the green button. Both used to be reported as
        "Ringing from your phone", so a rep on the older installed build was
        told a call was under way while the phone sat waiting for a tap.
      */
      if (status === 'done') return { took: true, via: via ?? null };
      if (status === 'failed' || status === 'expired') return { took: false, via: null };
      if (status === 'delivered') collected = true;
    } catch {
      // A blip on the way to a row that will still be there next time round.
    }
  }
  // Collected and not yet closed out: the phone has it, and how it went is
  // the handset's business rather than something to accuse it of failing.
  return { took: collected, via: collected ? 'collected' : null };
}

export function CallDispositionProvider({
  recordId, module, followUpField = 'next_followup_at', children,
}: {
  recordId: string;
  module: string;
  /** Canonical for Leads; legacy Inventory workspaces still use next_follow_up. */
  followUpField?: string;
  children: ReactNode;
}): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [target, setTarget] = useState<string | null>(null);
  const [providerCallId, setProviderCallId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [durationMinutes] = useState(1);
  const [disposition, setDisposition] = useState('Call Back Later');
  const [placing, setPlacing] = useState(false);

  /*
    The record itself, on the same query keys the record page and the split
    view use — so a value edited during the call invalidates every other screen
    showing it, and opening one warms the other.

    **Asked for while a call is running *or* while one is about to be placed.**
    Arriving on `?dial=1` from Save & Next, there is no call yet, so gating this
    on `target` alone left the number unknown, the auto-dial effect below
    returning early, and the flag sitting in the address bar for ever: Save &
    Next opened the next person and rang nobody. It had never once worked.
  */
  const dialParam = params.get('dial');
  const wanted = Boolean(target) || dialParam === '1';
  const { module: described, record } = useChatRecord(wanted ? module : null, wanted ? recordId : null);
  const [saving, setSaving] = useState(false);
  const placingRef = useRef(false);
  const savingRef = useRef(false);
  /*
    The outcome the dialog opens on has to be one the list still offers.

    "Call Back Later" is the sensible default and it is also just a string: an
    admin who deletes that option leaves the dialog defaulting to a value the
    server now refuses, and the rep sees a save fail on a dialog they never
    touched. So the default is the first option when it is no longer there.
  */
  const dispositions = useCallDispositions();
  const selected = dispositions.includes(disposition) ? disposition : (dispositions[0] ?? disposition);

  /*
    Whether this rep's phone can end a call at all.

    Android hands a running call to the **default phone app** and to nobody
    else, so this is a fact about the handset — reported by the app, not
    inferred from a version number, because a build can carry the code and
    still not be the chosen dialler. The console draws End dead until this
    says otherwise, which is the difference between a control and a lie.
  */
  const { data: phones } = useQuery({
    queryKey: ['device-phones'],
    queryFn: () => api.devices(),
    enabled: Boolean(target),
    staleTime: 30_000,
  });
  const canEndCall = (phones ?? []).some((row) => (row as { can_end_call?: boolean }).can_end_call === true);

  const hangUp = async (): Promise<void> => {
    try {
      const result = await api.hangUpOnPhone({ module, recordId });
      if (result.sent) toast.info('Ending the call', `${result.device ?? 'Your phone'} is hanging up.`);
      else toast.error('Could not end it from here', result.detail ?? 'Use the red button on the handset.');
    } catch (err) {
      toast.error('Could not end it from here', (err as Error).message);
    }
  };

  /*
    Who comes after this one, so the console can offer Save & dial next.

    The neighbour endpoint answers ids, which is all a list knows; the name
    and the number come from the record itself. Asked for only while the
    console is open, so an idle record page costs nothing.
  */
  const { data: neighbours } = useQuery({
    queryKey: ['call-next', module, recordId],
    queryFn: () => api.neighbours(module, recordId),
    enabled: Boolean(target),
    staleTime: 60_000,
  });
  const [skipped, setSkipped] = useState<string[]>([]);
  const nextId = neighbours?.nextId && !skipped.includes(neighbours.nextId) ? neighbours.nextId : null;
  const { data: nextRecord } = useQuery({
    queryKey: ['record', module, nextId],
    queryFn: () => api.record(module, nextId!),
    enabled: Boolean(target && nextId),
  });

  const discard = (): void => {
    setTarget(null);
    setProviderCallId(null);
    setStartedAt(null);
    setDisposition('Call Back Later');
    setSkipped([]);
  };

  const startCall = async (number: string, from: 'phone' | 'desk' = 'phone'): Promise<void> => {
    if (placingRef.current || target) return;
    placingRef.current = true;
    const clean = number.replace(/[^\d+]/g, '');
    setTarget(number);
    setStartedAt(Date.now());
    setPlacing(true);
    try {
      /*
        The rep asked for this one to leave from the computer, by clicking the
        number rather than the Call button. No phone is involved and none is
        asked: the desk hand-off is the whole intent, and queueing a command
        for a handset as well would ring two things at once.
      */
      if (!isNative && from === 'desk') {
        dial(clean);
        return;
      }
      /*
        The rep's own phone, wherever they pressed the button.

        On the phone itself that is its dialler, straight away. At a desk the
        laptop cannot place a phone call at all: handing it the number asks the
        browser which application should open it, and on a Mac that is a dialog
        naming FaceTime. So the CRM asks the paired handset to ring instead,
        and the call comes back in through the same sync that files every other
        call the rep makes.

        A laptop with no paired phone still falls back to the old hand-off —
        somebody may have a softphone set up, and a dialog is better than a
        button that does nothing.

        The CRM state is set before any of that, so the outcome form is already
        open and waiting when they come back.
      */
      if (isNative) {
        dial(clean);
      } else {
        let outcome: { took: boolean; via: string | null };
        const result = await api.dialOnPhone({ to: clean, module, recordId });
        if (!result.sent) {
          dial(clean);
        } else if ((outcome = await phoneTookIt(result.commandId)).took) {
          const phone = result.device ?? 'Your phone';
          if (outcome.via === 'dialler' || outcome.via === 'collected') {
            toast.success(
              'The number is on your phone',
              `${phone} has it — press the green button there if it is waiting.`,
            );
          } else {
            toast.success('Ringing from your phone', `${phone} is calling now.`);
          }
        } else {
          toast.error(
            'Phone call was not confirmed',
            'Open iPropy 2.0 on your Android phone and allow Phone calls when prompted, then press Call again.',
          );
        }
      }
    } catch (err) {
      toast.error('Could not place the call', (err as Error).message);
      close();
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  };

  const save = async (andDialNext: boolean): Promise<void> => {
    if (!target || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    /*
      Captured before the writes, because closing the console clears them and
      dialling the next person needs both.
    */
    const goTo = andDialNext ? nextId : null;
    try {
      const connected = !['No Answer', 'Busy', 'Switched Off', 'Not Reachable'].includes(selected);
      if (providerCallId) {
        await api.setDisposition(providerCallId, {
          disposition: selected,
        });
      } else {
        await api.logCall({
          to: target, recordId, module, direction: 'outbound',
          durationSeconds: connected ? minutesFrom(startedAt, Date.now(), durationMinutes) * 60 : 0,
          disposition: selected,
        });
      }

      /*
        The outcome chases them for you, and never argues with a date somebody
        has already chosen — the console's key bar lets a rep pick one while
        the call is still running.
      */
      const chaseOn = followUpFor(
        selected,
        (record?.values?.[followUpField] as string | null | undefined) ?? null,
        new Date(),
      );
      if (chaseOn) await api.update(module, recordId, { [followUpField]: chaseOn });

      toast.success(
        'Call logged',
        chaseOn ? 'Follow-up scheduled.' : 'One conversation moved forward.',
      );
      discard();
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['record-calls', recordId] }),
        queryClient.invalidateQueries({ queryKey: ['timeline', module, recordId] }),
        queryClient.invalidateQueries({ queryKey: ['record', module, recordId] }),
        queryClient.invalidateQueries({ queryKey: ['records', module] }),
        queryClient.invalidateQueries({ queryKey: ['task-count', module] }),
      ]);

      /*
        Dial next. The console belongs to whichever record is open, so this
        cannot switch person by itself — it opens the next record and asks it
        to start, which is also what makes the queue work identically from the
        split view, the table and a record's own page.
      */
      if (goTo) navigate(`/${module}/${goTo}?dial=1`);
    } catch (err) {
      toast.error('Could not log the call', (err as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /*
    Arriving from Save & dial next: ring this person straight away, once, and
    take the flag off the address so a refresh does not re-dial somebody who
    has already been called.
  */
  const phoneField = described?.fields.find((f) => f.uitype === 'phone');
  const autoNumber = phoneField ? (record?.display?.[phoneField.name] ?? record?.values?.[phoneField.name]) : null;
  /*
    **The flag belongs to the record the address names, and to no other.**

    Save & Next saves, clears the call, and navigates — all inside the provider
    belonging to the person just called. That outgoing instance sees the new
    `?dial=1` for a heartbeat before it is replaced, and with no guard it spent
    the flag: it stripped `dial` from the address and rang the number it still
    had, which was the person already dealt with. By the time the next record's
    provider mounted, the flag was gone and no deck appeared. From the desk it
    read as Save & Next opening the next person and doing nothing.

    `open` is the discriminator because the split view names the open record
    there; a provider whose record is not the one the address names is on its
    way out and must keep its hands off.
  */
  const namedInTheAddress = params.get('open');
  const isForThisRecord = !namedInTheAddress || namedInTheAddress === recordId;
  useEffect(() => {
    if (dialParam !== '1' || !isForThisRecord || target || !autoNumber) return;
    const next = new URLSearchParams(params);
    next.delete('dial');
    setParams(next, { replace: true });
    void startCall(String(autoNumber));
    // `startCall` is recreated on every render and guards itself with a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialParam, autoNumber, target, isForThisRecord]);

  const nextLabel = nextRecord ? String(nextRecord.display?.full_name ?? nextRecord.label ?? 'Next record') : null;

  /*
    Everything the deck needs, and nothing it does not. Null when no call is
    running, which is what tells a header to draw nothing at all.
  */
  const deck: CallDeckProps | null = target ? {
    startedAt,
    placing,
    position: neighbours?.position ?? null,
    total: neighbours?.total ?? null,
    outcomes: dispositions,
    outcome: selected,
    onOutcome: setDisposition,
    canEndCall,
    onHangUp: () => void hangUp(),
    saving,
    nextLabel,
    onSave: (andDialNext: boolean) => void save(andDialNext),
    onDiscard: discard,
  } : null;

  return (
    <CallDispositionContext.Provider value={{ startCall, deck }}>
      {children}
    </CallDispositionContext.Provider>
  );
}

export function CallButton({ to, iconOnly = false, round = false }: { to: string; iconOnly?: boolean; round?: boolean }): JSX.Element {
  const calls = useCallDisposition();
  return (
    <button
      type="button"
      // `iconOnly` where the header is tight — the split view, above all. The
      // word costs a third of the strip for a button everybody recognises by
      // its shape, and the title still says what it does.
      // `round` is the split view's own shape: a plain circle in the
      // record's action strip, neutral at rest — four tinted circles in a
      // line read as four warnings — and filling with its own colour under
      // the cursor, so it says what it is exactly when that matters.
      className={round
        ? 'inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:border-transparent hover:text-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 hover:bg-blue-600'
        : cn('btn-secondary btn-sm', iconOnly && 'h-9 w-9 justify-center px-0')}
      title={`Call ${to}`}
      aria-label={`Call ${to}`}
      onClick={() => void calls?.startCall(to)}
    >
      <Phone className={round ? 'h-4 w-4' : 'h-3.5 w-3.5 text-blue-600'} />
      {!iconOnly && !round && <span className="hidden sm:inline">Call</span>}
    </button>
  );
}
