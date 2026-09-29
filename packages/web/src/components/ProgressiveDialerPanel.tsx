import { type JSX, useEffect } from 'react';
import { CheckCircle2, Pause, PhoneCall, Play, RotateCcw, Square, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCallDisposition } from './CallDisposition';
import { useLiveCall } from '../lib/liveCall';
import { progressiveRecordUrl, useProgressiveDialer } from '../lib/progressiveDialer';
import { useApp } from '../lib/store';
import { cn } from '../lib/utils';

export function ProgressiveDialerPanel({ module, recordId }: { module: string; recordId: string }): JSX.Element | null {
  const session = useProgressiveDialer((state) => state.session);
  const userId = useApp((state) => state.user?.id ?? null);
  const liveCall = useLiveCall((state) => state.call);
  const calls = useCallDisposition();
  const navigate = useNavigate();

  useEffect(() => {
    if (session && userId && session.userId !== userId) useProgressiveDialer.getState().clear();
  }, [session, userId]);

  if (!session || !userId || session.userId !== userId || session.module !== module) return null;

  const current = session.items[session.index] ?? null;
  const onCurrent = current?.id === recordId;
  const finished = session.status === 'completed';
  const stopped = session.status === 'stopped';
  const activeCallHere = Boolean(liveCall && liveCall.userId === userId && liveCall.recordId === current?.id);
  const done = Math.min(session.index, session.items.length);

  const openCurrent = (): void => {
    if (current) navigate(progressiveRecordUrl(session, current), { state: { progressiveDialerHandoff: Date.now() } });
  };

  const callCurrent = (): void => {
    if (!current || !onCurrent || session.status !== 'waiting' || liveCall) return;
    void calls?.startCall(current.number);
  };

  return (
    <section className="card h-fit overflow-hidden border-brand-200 dark:border-brand-900" data-testid="progressive-dialer-panel">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-brand-50 px-3 py-2 dark:bg-brand-950/50">
        <span className="flex min-w-0 items-center gap-2">
          <PhoneCall className="h-4 w-4 shrink-0 text-brand-700 dark:text-brand-300" />
          <span className="truncate text-sm font-bold text-[var(--text)]">Progressive Dialer</span>
        </span>
        <span className="text-xs font-semibold tabular-nums text-brand-700 dark:text-brand-300">
          {finished ? session.items.length : Math.min(session.index + 1, session.items.length)} / {session.items.length}
        </span>
      </header>

      <div className="space-y-2.5 p-3">
        {finished ? (
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-5 w-5" /> Queue completed
          </div>
        ) : stopped ? (
          <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">Queue stopped after {done} record{done === 1 ? '' : 's'}.</p>
        ) : current ? (
          <>
            <div>
              <p className="truncate text-sm font-bold text-[var(--text)]">{current.label}</p>
              <p className="text-xs text-muted">{current.number} · {session.status === 'paused' ? 'Paused' : activeCallHere ? 'Call in progress' : 'Waiting for confirmation'}</p>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-label={`${done} of ${session.items.length} completed`}>
              <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${(done / session.items.length) * 100}%` }} />
            </div>
          </>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {!finished && !stopped && current && !onCurrent && (
            <button type="button" className="btn-primary btn-sm" onClick={openCurrent}>Open current</button>
          )}
          {!finished && !stopped && current && onCurrent && session.status === 'waiting' && (
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={Boolean(liveCall) || !calls}
              onClick={callCurrent}
              data-testid="progressive-call-current"
            >
              <PhoneCall className="h-3.5 w-3.5" /> {activeCallHere ? 'Calling…' : 'Call current'}
            </button>
          )}
          {!finished && !stopped && session.status === 'paused' && (
            <button type="button" className="btn-primary btn-sm" onClick={() => useProgressiveDialer.getState().resume()}>
              <Play className="h-3.5 w-3.5" /> Resume
            </button>
          )}
          {!finished && !stopped && session.status !== 'paused' && (
            <button type="button" className="btn-secondary btn-sm" disabled={Boolean(liveCall)} onClick={() => useProgressiveDialer.getState().pause()}>
              <Pause className="h-3.5 w-3.5" /> Pause
            </button>
          )}
          {!finished && !stopped && (
            <button type="button" className="btn-secondary btn-sm" disabled={Boolean(liveCall)} onClick={() => useProgressiveDialer.getState().stop()}>
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          )}
          {(finished || stopped) && (
            <button type="button" className="btn-secondary btn-sm" onClick={() => useProgressiveDialer.getState().clear()}>
              <X className="h-3.5 w-3.5" /> Close
            </button>
          )}
          {stopped && (
            <button
              type="button"
              className={cn('btn-primary btn-sm', !current && 'hidden')}
              onClick={() => useProgressiveDialer.getState().resume()}
            >
              <RotateCcw className="h-3.5 w-3.5" /> Resume queue
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

