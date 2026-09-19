import { createContext, type JSX, type ReactNode, useContext, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mic, Phone, Square } from 'lucide-react';
import { api } from '../lib/api';
import { useCallDispositions } from '../lib/callDispositions';
import { toast } from '../lib/store';
import { useVoiceCapture } from '../lib/useVoiceCapture';
import { cn } from '../lib/utils';
import { Modal, Spinner } from './ui';
import { dial } from '../lib/nativeActions';
import { isNative } from '../lib/native';

interface CallActions {
  startCall: (number: string) => Promise<void>;
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
async function phoneTookIt(commandId: string | undefined): Promise<boolean> {
  if (!commandId) return false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    try {
      const { status } = await api.dialStatus(commandId);
      if (status === 'done') return true;
      if (status === 'failed' || status === 'expired') return false;
    } catch {
      // A blip on the way to a row that will still be there next time round.
    }
  }
  return false;
}

export function CallDispositionProvider({
  recordId, module, recordLabel, followUpField = 'next_followup_at', children,
}: {
  recordId: string;
  module: string;
  recordLabel: string;
  /** Canonical for Leads; legacy Inventory workspaces still use next_follow_up. */
  followUpField?: string;
  children: ReactNode;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const [providerCallId, setProviderCallId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [durationMinutes, setDurationMinutes] = useState(1);
  const [disposition, setDisposition] = useState('Call Back Later');
  const [nextFollowUp, setNextFollowUp] = useState('');
  const [notes, setNotes] = useState('');
  const [placing, setPlacing] = useState(false);
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

  const voice = useVoiceCapture(async (audio) => {
    try {
      const { note } = await api.voiceNote(audio);
      setNotes((current) => current.trim() ? `${current.trim()}\n${note}` : note);
    } catch (err) {
      toast.error('Could not write the call note', (err as Error).message);
    }
  });

  const close = (): void => {
    voice.cancel();
    setTarget(null);
    setProviderCallId(null);
    setStartedAt(null);
    setDurationMinutes(1);
    setDisposition('Call Back Later');
    setNextFollowUp('');
    setNotes('');
  };

  const startCall = async (number: string): Promise<void> => {
    if (placingRef.current || target) return;
    placingRef.current = true;
    const clean = number.replace(/[^\d+]/g, '');
    setTarget(number);
    setStartedAt(Date.now());
    setPlacing(true);
    try {
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
        const result = await api.dialOnPhone({ to: clean, module, recordId });
        if (!result.sent) {
          dial(clean);
        } else if (await phoneTookIt(result.commandId)) {
          toast.success('Ringing from your phone', `${result.device ?? 'Your phone'} is calling now.`);
        } else {
          /*
            The two ordinary ways this goes quiet, and neither may be reported
            as a call: a handset that is off or out of signal, and an app one
            version behind that has never heard of placing a call. The desk
            hand-off is offered instead, so the rep finds out here rather than
            from a customer who was never rung.
          */
          toast.error('Your phone did not pick that up', 'Is it on, unlocked, and running the latest iPropy app?');
          dial(clean);
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

  const save = async (): Promise<void> => {
    console.log('DBG save entered', JSON.stringify({ target, saving: savingRef.current, notes, selected }));
    if (!target || savingRef.current) return;
    const today = new Date().toISOString().slice(0, 10);
    if (nextFollowUp && nextFollowUp < today) {
      toast.error('Choose today or a future date', 'A next follow-up is a task and cannot be scheduled in the past.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      if (providerCallId) {
        await api.setDisposition(providerCallId, {
          disposition: selected,
          notes: notes.trim() || undefined,
        });
      } else {
        const elapsed = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 60_000)) : 1;
        const connected = !['No Answer', 'Busy', 'Switched Off', 'Not Reachable'].includes(selected);
        await api.logCall({
          to: target, recordId, module, direction: 'outbound',
          durationSeconds: connected ? Math.max(durationMinutes, elapsed) * 60 : 0,
          disposition: selected,
          notes: notes.trim() || undefined,
        });
      }
      if (nextFollowUp) await api.update(module, recordId, { [followUpField]: nextFollowUp });
      toast.success(
        'Call logged',
        nextFollowUp ? 'Nice work — your next follow-up is scheduled.' : 'One conversation moved forward. Keep the momentum going.',
      );
      // Close as soon as the write succeeds. Refetching the tabs is background
      // work and must never hold the form on screen after Save.
      close();
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['record-calls', recordId] }),
        queryClient.invalidateQueries({ queryKey: ['timeline', module, recordId] }),
        queryClient.invalidateQueries({ queryKey: ['record', module, recordId] }),
        queryClient.invalidateQueries({ queryKey: ['records', module] }),
        queryClient.invalidateQueries({ queryKey: ['task-count', module] }),
      ]);
    } catch (err) {
      console.log('DBG save failed', String(err));
      toast.error('Could not log the call', (err as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <CallDispositionContext.Provider value={{ startCall }}>
      {children}
      <Modal
        open={Boolean(target)}
        onClose={close}
        title={`Log call with ${recordLabel}${target ? ` · ${target}` : ''}`}
        size="sm"
        footer={(
          <>
            <button className="btn-secondary" onClick={close} disabled={saving}>Did not call</button>
            <button className="btn-primary" disabled={saving || placing} onClick={() => { console.log('DBG click fired'); void save(); }}>
              {saving && <Spinner className="h-3.5 w-3.5" />} Save call
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="call-outcome">Outcome</label>
            <select id="call-outcome" className="input" value={selected} onChange={(event) => setDisposition(event.target.value)}>
              {dispositions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          {!providerCallId && (
            <div>
              <label className="label" htmlFor="call-duration">Approximate duration (minutes)</label>
              <input
                id="call-duration" className="input tnum" type="number" min={0} max={600}
                value={durationMinutes}
                onChange={(event) => setDurationMinutes(Math.max(0, Number(event.target.value) || 0))}
              />
            </div>
          )}
          <div>
            <label className="label" htmlFor="call-next-follow-up">Next follow-up (task)</label>
            <input
              id="call-next-follow-up"
              className="input"
              type="date"
              min={new Date().toISOString().slice(0, 10)}
              value={nextFollowUp}
              onChange={(event) => setNextFollowUp(event.target.value)}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="label mb-0" htmlFor="call-notes">Disposition notes (optional)</label>
              <button
                type="button"
                className={cn('btn-ghost btn-sm', voice.recording && 'text-red-600')}
                onClick={voice.toggle}
                disabled={!voice.supported || voice.busy}
                title={voice.recording ? 'Stop dictation' : 'Speak disposition notes'}
              >
                {voice.busy ? <Spinner className="h-3.5 w-3.5" />
                  : voice.recording ? <Square className="h-3.5 w-3.5 fill-current" />
                    : <Mic className="h-3.5 w-3.5" />}
                {voice.recording ? 'Stop' : voice.busy ? 'Writing…' : 'Speak'}
              </button>
            </div>
            <textarea
              id="call-notes" className="input" rows={4} value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="What happened on the call?"
            />
          </div>
          {placing && <p className="text-xs text-muted">Connecting the call…</p>}
        </div>
      </Modal>
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
      // `round` is the split view's own shape: a tinted circle in the
      // record's action strip, the colour of the thing it opens.
      className={round
        ? 'inline-flex h-8 w-8 items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-blue-600 transition-colors hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300'
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
