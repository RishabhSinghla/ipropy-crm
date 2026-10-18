import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, Pause, Play, RotateCcw, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { Modal } from './ui';

const RETRY = new Set(['failed', 'busy', 'no_answer']);
const labels: Record<string, string> = {
  pending: 'Remaining', submitting: 'Submitting call', waiting: 'Dial requested · awaiting result',
  queued: 'Awaiting Sarvam result', completed: 'Answered', busy: 'Busy', no_answer: 'No answer',
  failed: 'Failed', unknown: 'Unknown · check Sarvam', skipped: 'Skipped', canceled: 'Cancelled',
};

/** Mounted in the shell: the queue and its stop control stay available across CRM pages. */
export function SarvamControl(): JSX.Element {
  const { user } = useApp();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'queue' | 'history'>('queue');
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ['sarvam-control'], queryFn: api.sarvamControl,
    refetchInterval: open ? 3000 : 10000, refetchIntervalInBackground: true });
  const data = query.data;
  useEffect(() => {
    const show = (event: Event): void => {
      const id = (event as CustomEvent<string>).detail;
      if (id) setSelected(id);
      setTab('queue'); setOpen(true); void cache.invalidateQueries({ queryKey: ['sarvam-control'] });
    };
    window.addEventListener('sarvam-control-open', show);
    return () => window.removeEventListener('sarvam-control-open', show);
  }, [cache]);
  const batches = data?.batches ?? [];
  const batch = batches.find((b) => b.id === selected) ?? batches.find((b) => b.status === 'running') ?? batches[0];
  const items = (data?.items ?? []).filter((item) => item.batch_id === batch?.id);
  const active = (data?.items ?? []).filter((i) => ['submitting', 'waiting', 'unknown'].includes(i.status));
  const running = batches.filter((b) => b.status === 'running');
  const awaiting = Math.max(data?.totals?.awaiting_result ?? 0, active.length);
  const pendingCalls = (data?.calls ?? []).filter((call) => call.status === 'queued');
  const remaining = items.filter((i) => i.status === 'pending').length;
  const done = items.filter((i) => i.status === 'completed').length;
  const failed = items.filter((i) => RETRY.has(i.status)).length;
  const mayControl = user?.isAdmin || batch?.user_id === user?.id;
  const refresh = async (): Promise<void> => { await cache.invalidateQueries({ queryKey: ['sarvam-control'] }); };
  const action = async (kind: 'pause' | 'resume' | 'retry'): Promise<void> => {
    if (!batch || busy) return;
    setBusy(true);
    try { await api.sarvamQueueAction(batch.id, kind); await refresh(); }
    catch (error) { toast.error('Could not update AI queue', (error as Error).message); }
    finally { setBusy(false); }
  };
  const retryCall = async (recordId: string, module: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.createSarvamQueue(module, [recordId]);
      setSelected(result.id); setTab('queue'); await refresh();
      toast.info('Retry prepared', 'Review the contact and press Start / resume to call.');
    } catch (error) { toast.error('Could not prepare retry', (error as Error).message); }
    finally { setBusy(false); }
  };
  const matches = (status: string): boolean => filter === 'all' || (filter === 'retry' ? RETRY.has(status) : filter === 'pending' ? status === 'pending' : status === filter);
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label="Open Sarvam AI call control"
      className="fixed bottom-20 left-3 z-40 flex items-center gap-2 rounded-full border border-violet-300 bg-white px-4 py-2 text-sm font-semibold text-violet-800 shadow-lg dark:border-violet-700 dark:bg-slate-900 dark:text-violet-200 md:bottom-4">
      <Activity className={`h-4 w-4 ${awaiting || running.length ? 'animate-pulse' : ''}`} />
      AI calls {awaiting ? `· ${awaiting} awaiting result` : running.length ? '· dialing' : ''}
    </button>
    <Modal open={open} onClose={() => setOpen(false)} title="Sarvam AI call control" size="lg" footer={<button className="btn-secondary" onClick={() => setOpen(false)}>Minimise · queue stays saved</button>}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span className="flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${query.isError ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'}`} />{query.isError ? 'Connection lost · status may be outdated' : 'Live · refreshes every 3 seconds'}</span>
          <span>{user?.isAdmin ? 'Team calls' : 'Your calls'} · India time</span>
        </div>
        {query.isError && <p role="alert" className="text-sm text-red-600">{(query.error as Error).message} <button onClick={() => void refresh()} className="underline">Reconnect</button></p>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[[data?.totals?.attempted ?? 0,'Total attempts'],[data?.totals?.today ?? 0,'Today'],[data?.totals?.completed ?? 0,'Answered'],[data?.totals?.unsuccessful ?? 0,'Unsuccessful']].map(([value,label]) =>
            <div className="rounded-xl bg-slate-100 p-3 dark:bg-slate-800" key={label}><div className="text-xl font-bold">{value}</div><div className="text-xs text-muted">{label}</div></div>)}
        </div>
        {pendingCalls.length > 0 && <div className="rounded-lg border border-violet-200 p-3 text-sm dark:border-violet-800"><p className="font-semibold">{awaiting} calls awaiting a confirmed result</p>{pendingCalls.slice(0, 3).map((call) => <p key={call.id} className="mt-1 text-xs text-muted">{call.label ?? call.phone} · {Date.now() - new Date(call.started_at).getTime() > 15 * 60_000 ? 'Result overdue · check Sarvam' : 'Dial accepted · waiting for outcome'}</p>)}</div>}
        <div className="flex gap-2"><button className={tab === 'queue' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setTab('queue')}>Saved queues</button><button className={tab === 'history' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setTab('history')}>Call history</button></div>
        {tab === 'queue' ? <>
          <label className="block text-xs text-muted">Queue<select className="input mt-1 w-full" value={batch?.id ?? ''} onChange={(e) => { setSelected(e.target.value); setFilter('all'); }}>
            {!batches.length && <option>No saved queues</option>}
            {batches.map((b) => <option key={b.id} value={b.id}>{b.module} · {b.status} · {new Date(b.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</option>)}
          </select></label>
          {batch ? <>
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 dark:border-violet-800 dark:bg-violet-950">
              <p className="flex items-center gap-2 font-semibold"><Sparkles className={`h-4 w-4 ${batch.status === 'running' ? 'animate-pulse' : ''}`} />{batch.status === 'running' ? 'AI queue running' : batch.status === 'done' ? 'Queue finished' : 'Queue paused'}</p>
              <p className="mt-1 text-sm">{items.length} contacts · {done} answered · {failed} unsuccessful · {remaining} remaining</p>
              <div className="mt-2 h-2 overflow-hidden rounded bg-violet-200"><div className="h-full bg-violet-600 transition-all" style={{ width: `${items.length ? (items.filter((i) => !['pending','waiting','submitting','unknown'].includes(i.status)).length / items.length) * 100 : 0}%` }} /></div>
              {batch.message && <p role="status" className="mt-2 text-sm text-amber-800 dark:text-amber-200">{batch.message}</p>}
              {items.filter((i) => ['submitting','waiting','unknown'].includes(i.status)).map((item) => <p key={item.id} className="mt-2 text-sm font-semibold">{item.label} · {labels[item.status]}</p>)}
              <div className="mt-3 flex flex-wrap gap-2">
                {mayControl && <>
                  {batch.status === 'running' ? <button className="btn-danger btn-sm" disabled={busy} onClick={() => void action('pause')}><Pause className="h-4 w-4" />Stop further calls</button> : <button className="btn-primary btn-sm" disabled={busy || !remaining || items.some((i) => i.status === 'unknown')} onClick={() => void action('resume')}><Play className="h-4 w-4" />Start / resume {remaining}</button>}
                  <button className="btn-secondary btn-sm" disabled={busy || !failed || batch.status === 'running' || items.some((i) => ['waiting','submitting'].includes(i.status))} onClick={() => void action('retry')}><RotateCcw className="h-4 w-4" />Prepare {failed} unsuccessful for retry</button>
                </>}
              </div>
            </div>
            <p className="text-xs text-muted">Stop prevents the next dial. A call already submitted to Sarvam can finish; its public API does not provide a live hang-up control. Awaiting result means a dial was accepted, not proof the customer answered.</p>
          </> : <p className="text-sm text-muted">Select contacts in Leads and choose AI call to prepare a batch. Saved queues remain here after navigation or refresh.</p>}
          <select aria-label="Filter AI queue" className="input" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All contacts</option><option value="pending">Remaining</option><option value="completed">Answered</option><option value="retry">Unsuccessful / retry</option><option value="unknown">Unknown</option><option value="skipped">Skipped</option></select>
          <div className="max-h-72 space-y-2 overflow-auto">
            {items.filter((i) => matches(i.status)).map((item) => <div key={item.id} className="rounded-lg border p-3 text-sm dark:border-slate-700">
              <div className="flex justify-between gap-3"><Link className="font-medium text-brand-600" to={`/${batch!.module}/${item.record_id}`} onClick={() => setOpen(false)}>{item.label}</Link><span className={RETRY.has(item.status) || item.status === 'unknown' ? 'text-amber-700 dark:text-amber-300' : 'text-muted'}>{labels[item.status] ?? item.status}</span></div>
              <div className="mt-1 text-xs text-muted">{item.phone}</div>{item.error && <p className="mt-1 text-xs">{item.error}</p>}
              {mayControl && item.status === 'unknown' && <button className="mt-2 text-xs underline" disabled={busy} onClick={() => {
                if (window.confirm('Have you checked this call in Sarvam and confirmed it has ended? This will allow the queue to resume and make this contact eligible for retry.')) {
                  setBusy(true); void api.resolveSarvamItem(item.id).then(refresh).catch((e: Error) => toast.error('Could not resolve call', e.message)).finally(() => setBusy(false));
                }
              }}>I verified this call ended in Sarvam</button>}
            </div>)}
          </div>
        </> : <>
          <p className="text-xs text-muted">Latest 100 attempts. Totals above include all CRM Sarvam attempts. <Link className="underline" to="/calls" onClick={() => setOpen(false)}>Open all calls and date filters</Link></p>
          <div className="max-h-96 space-y-2 overflow-auto">{data?.calls.map((call) => <div key={call.id} className="rounded-lg border p-3 text-sm dark:border-slate-700">
            <div className="flex justify-between gap-2"><span className="font-medium">{call.label ?? call.phone}</span><span>{labels[call.status] ?? call.status}</span></div>
            <p className="text-xs text-muted">{new Date(call.started_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · {call.duration_seconds}s</p>
            {call.notes && <p className="mt-1 text-xs">{call.notes}</p>}
            {RETRY.has(call.status) && call.record_id && call.record_module && <button className="mt-2 text-xs text-brand-600 underline" disabled={busy} onClick={() => void retryCall(call.record_id!, call.record_module!)}>Prepare retry</button>}
          </div>)}</div>
        </>}
      </div>
    </Modal>
  </>;
}
