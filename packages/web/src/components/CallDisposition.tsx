import { createContext, type JSX, type ReactNode, useContext, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CALL_DISPOSITIONS } from '@ipropy/shared';
import { Mic, Phone, Square } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { useVoiceCapture } from '../lib/useVoiceCapture';
import { cn } from '../lib/utils';
import { Modal, Spinner } from './ui';

interface CallActions {
  startCall: (number: string) => Promise<void>;
}

const CallDispositionContext = createContext<CallActions | null>(null);

/** Returns null outside a record page, where a normal tel: link is correct. */
export function useCallDisposition(): CallActions | null {
  return useContext(CallDispositionContext);
}

export function CallDispositionProvider({
  recordId, module, recordLabel, children,
}: {
  recordId: string;
  module: string;
  recordLabel: string;
  children: ReactNode;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { telephonyAvailable } = useApp();
  const [target, setTarget] = useState<string | null>(null);
  const [providerCallId, setProviderCallId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [durationMinutes, setDurationMinutes] = useState(1);
  const [disposition, setDisposition] = useState('Call Back Later');
  const [notes, setNotes] = useState('');
  const [placing, setPlacing] = useState(false);
  const [saving, setSaving] = useState(false);

  const voice = useVoiceCapture(async (audio) => {
    try {
      const { note } = await api.voiceNote(audio);
      setNotes((current) => current.trim() ? `${current.trim()}\n${note}` : note);
    } catch (err) {
      toast.error('Could not write the call note', (err as Error).message);
    }
  });

  const close = (): void => {
    setTarget(null);
    setProviderCallId(null);
    setStartedAt(null);
    setDurationMinutes(1);
    setDisposition('Call Back Later');
    setNotes('');
  };

  const startCall = async (number: string): Promise<void> => {
    if (placing) return;
    const clean = number.replace(/[^\d+]/g, '');
    setTarget(number);
    setStartedAt(Date.now());
    setPlacing(true);
    try {
      if (telephonyAvailable) {
        const placed = await api.call(number, recordId, module);
        setProviderCallId(placed.callId);
        toast.success('Calling…', `Connecting ${recordLabel} on ${number}`);
      } else {
        // Set the CRM state before leaving for the phone dialler. When the user
        // returns, the already-open form is ready for the outcome and notes.
        window.location.href = `tel:${clean}`;
      }
    } catch (err) {
      toast.error('Could not place the call', (err as Error).message);
      close();
    } finally {
      setPlacing(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!target) return;
    setSaving(true);
    try {
      if (providerCallId) {
        await api.setDisposition(providerCallId, {
          disposition,
          notes: notes.trim() || undefined,
        });
      } else {
        const elapsed = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 60_000)) : 1;
        const connected = !['No Answer', 'Busy', 'Switched Off', 'Not Reachable'].includes(disposition);
        await api.logCall({
          to: target, recordId, module, direction: 'outbound',
          durationSeconds: connected ? Math.max(durationMinutes, elapsed) * 60 : 0,
          disposition,
          notes: notes.trim() || undefined,
        });
      }
      // The visible Calls tab and the timeline must change in the same moment
      // as the success toast; waiting for stale-time made a saved call look lost.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['record-calls', recordId] }),
        queryClient.invalidateQueries({ queryKey: ['timeline', module, recordId] }),
      ]);
      toast.success('Call logged');
      close();
    } catch (err) {
      toast.error('Could not log the call', (err as Error).message);
    } finally {
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
            <button className="btn-primary" disabled={saving || placing} onClick={() => void save()}>
              {saving && <Spinner className="h-3.5 w-3.5" />} Save call
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          <div>
            <label className="label">Outcome</label>
            <select className="input" value={disposition} onChange={(event) => setDisposition(event.target.value)}>
              {CALL_DISPOSITIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          {!providerCallId && (
            <div>
              <label className="label">Approximate duration (minutes)</label>
              <input
                className="input tnum" type="number" min={0} max={600}
                value={durationMinutes}
                onChange={(event) => setDurationMinutes(Math.max(0, Number(event.target.value) || 0))}
              />
            </div>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="label mb-0">Disposition notes (optional)</label>
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
              className="input" rows={4} value={notes}
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

export function CallButton({ to }: { to: string }): JSX.Element {
  const calls = useCallDisposition();
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      title={`Call ${to}`}
      onClick={() => void calls?.startCall(to)}
    >
      <Phone className="h-3.5 w-3.5 text-blue-600" />
      <span className="hidden sm:inline">Call</span>
    </button>
  );
}
