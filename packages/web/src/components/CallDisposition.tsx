import {
  createContext, type JSX, type ReactNode, useContext, useEffect, useRef, useState,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Phone } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { useLiveCall } from '../lib/liveCall';
import { useChatRecord } from './ChatRecordPane';
import { dial } from '../lib/nativeActions';
import { isNative } from '../lib/native';

interface CallActions {
  /**
   * Ring somebody from this record.
   *
   * `from` is which handset places it, and the two are deliberately different
   * controls on screen (21 September 2026, the owner): the **Call icon** rings
   * the rep's Android phone, and **the number itself** hands off to whatever
   * this computer uses for `tel:` — a softphone on a Mac or a Windows machine.
   *
   * The call itself is the CRM's, not this page's (`useLiveCall`), and the deck
   * is drawn once by the app's shell — so leaving this record mid-call no
   * longer throws the call away.
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
 * Polled rather than pushed: the answer is one row and the wait is seconds.
 * `delivered` — the phone collected the instruction — is already the answer
 * to "did it reach the handset"; only `done` says what happened next, which
 * lands after the rep has taken the phone out. Waiting for `done` alone is how
 * a call that rang perfectly well was once reported as "not confirmed".
 */
async function phoneTookIt(
  commandId: string | undefined,
): Promise<{ took: boolean; via: string | null }> {
  if (!commandId) return { took: false, via: null };
  let collected = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    try {
      const { status, via } = await api.dialStatus(commandId);
      if (status === 'done') return { took: true, via: via ?? null };
      if (status === 'failed' || status === 'expired') return { took: false, via: null };
      if (status === 'delivered') collected = true;
    } catch {
      // A blip on the way to a row that will still be there next time round.
    }
  }
  return { took: collected, via: collected ? 'collected' : null };
}

export function CallDispositionProvider({
  recordId, module, followUpField = 'next_followup_at', queue, children,
}: {
  recordId: string;
  module: string;
  /** Canonical for Leads; legacy Inventory workspaces still use next_follow_up. */
  followUpField?: string;
  /** The next row in the current filtered and sorted split queue. */
  queue?: { nextId: string | null | undefined; position: number | null; total: number | null; url: string };
  children: ReactNode;
}): JSX.Element {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const live = useLiveCall((state) => state.call);
  const userId = useApp((state) => state.user?.id ?? null);
  const placingRef = useRef(false);

  /*
    Save & Next names the next record in `open` before this provider has
    received that record from the workspace. Preserve that addressed id while
    the pane catches up, and remove the one-shot URL flag immediately. This
    prevents a refresh from ringing the same person twice without losing the
    pending dial while the record and its phone field load.
  */
  const dialParam = params.get('dial');
  const addressedRecordId = params.get('open') || recordId;
  const handoff = location.state as { autoDialRecordId?: string; callDeckHandoff?: number } | null;
  const [pendingAutoDial, setPendingAutoDial] = useState<string | null>(null);
  useEffect(() => {
    const target = dialParam === '1' ? addressedRecordId : handoff?.autoDialRecordId;
    if (!target) return;
    setPendingAutoDial(target);
    if (dialParam === '1') {
      const next = new URLSearchParams(window.location.search);
      next.delete('dial');
      setParams(next, { replace: true });
      return;
    }
    // The navigation state transfers a one-shot request without exposing it in
    // the address bar. Replace it immediately so a browser refresh cannot dial
    // the next person a second time.
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: { callDeckHandoff: handoff?.callDeckHandoff },
    });
  }, [dialParam, addressedRecordId, handoff?.autoDialRecordId, handoff?.callDeckHandoff, location.pathname, location.search, navigate, setParams]);

  /*
    The record itself, asked for only when arriving from Save & Next with
    `?dial=1`, so the number to ring is known. Without it the flag sat in the
    address bar for ever and nobody was rung — which had happened.
  */
  const { module: described, record } = useChatRecord(
    pendingAutoDial ? module : null,
    pendingAutoDial,
  );

  const startCall = async (number: string, from: 'phone' | 'desk' = 'phone'): Promise<void> => {
    if (placingRef.current) return;
    const existingCall = useLiveCall.getState().call;
    if (existingCall && existingCall.userId !== userId) useLiveCall.getState().finish();
    else if (existingCall) {
      toast.info('You are already on a call', 'Save it with Save & Exit or Save & Next, then call again.');
      return;
    }
    if (!userId) {
      toast.error('Could not place the call', 'Your CRM session is still loading. Please try again.');
      return;
    }
    placingRef.current = true;
    const clean = number.replace(/[^\d+]/g, '');
    useLiveCall.getState().begin({
      userId, number, module, recordId, followUpField,
      ...(queue ? {
        // Unknown yet: leave it out so the deck asks rather than deciding "nobody".
        ...(queue.nextId !== undefined ? { queueNextId: queue.nextId } : {}),
        queuePosition: queue.position === null ? null : queue.position + 1,
        queueTotal: queue.total,
        queueUrl: queue.url,
      } : {}),
    });
    try {
      /*
        The rep asked for this one to leave from the computer, by clicking the
        number rather than the Call button. No phone is involved and none is
        asked: queueing a command for a handset as well would ring two things.
      */
      if (!isNative && from === 'desk') {
        dial(clean);
        return;
      }
      /*
        The rep's own phone, wherever they pressed the button. On the phone
        itself that is its dialler, straight away; at a desk the CRM asks the
        paired handset to ring. A laptop with no paired phone falls back to
        the old hand-off — a dialog is better than a button that does nothing.
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
            toast.success('The number is on your phone', `${phone} has it — press the green button there if it is waiting.`);
          } else {
            toast.success('Ringing from your phone', `${phone} is calling now.`);
          }
        } else {
          toast.error(
            'Phone call was not confirmed',
            'Open iPropy on your Android phone and allow Phone calls when prompted, then press Call again.',
          );
        }
      }
    } catch (err) {
      toast.error('Could not place the call', (err as Error).message);
      useLiveCall.getState().finish();
    } finally {
      placingRef.current = false;
      useLiveCall.getState().update({ placing: false });
    }
  };

  /*
    Arriving from Save & Next: ring this person straight away, once, and take
    the flag off the address so a refresh does not re-dial somebody already
    called.

    **The flag belongs to the record the address names, and to no other.**
    A provider for a record the address does not name (`open`) is on its way
    out and must keep its hands off — it once spent the flag ringing the
    person just dealt with.
  */
  const phoneField = described?.fields.find((f) => f.uitype === 'phone');
  const autoNumber = phoneField ? (record?.display?.[phoneField.name] ?? record?.values?.[phoneField.name]) : null;
  useEffect(() => {
    if (!pendingAutoDial || pendingAutoDial !== recordId || live || !autoNumber) return;
    setPendingAutoDial(null);
    void startCall(String(autoNumber));
    // `startCall` is recreated on every render and guards itself with a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoDial, recordId, autoNumber, live]);

  return (
    <CallDispositionContext.Provider value={{ startCall }}>
      {children}
    </CallDispositionContext.Provider>
  );
}

export function CallButton({ to, iconOnly = false, round = false, plain = false, active = false }: { to: string; iconOnly?: boolean; round?: boolean; plain?: boolean; active?: boolean }): JSX.Element {
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
      className={plain ? cn('inline-flex items-center justify-center p-1 text-slate-500 hover:text-brand-600', active && 'text-emerald-600') : round
        ? cn('inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors', active
          ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500'
          : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-transparent hover:bg-blue-600 hover:text-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300')
        : cn('btn-secondary btn-sm', iconOnly && 'h-9 w-9 justify-center px-0')}
      title={`Call ${to}`}
      aria-label={`Call ${to}`}
      aria-pressed={round ? active : undefined}
      onClick={() => void calls?.startCall(to)}
    >
      <Phone className={round ? 'h-4 w-4' : 'h-3.5 w-3.5 text-blue-600'} />
      {!iconOnly && !round && <span className="hidden sm:inline">Call</span>}
    </button>
  );
}
