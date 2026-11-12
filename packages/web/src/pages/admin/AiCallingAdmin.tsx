import { type JSX, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Eye, Play, ShieldAlert } from 'lucide-react';
import { api, type AiCallModuleSchedule, type AiCallPreview } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Skeleton } from '../../components/ui';
import { AiCallingProgress } from '../../components/AiCallingProgress';

/**
 * Automatic daily AI calling.
 *
 * Everything here starts OFF. The safe order is: pick who may be called (a saved view) → Preview (calls nobody) →
 * Run now with a tiny limit → only then the master switch. Real customers are rung only by the queue, inside calling
 * hours, and never anybody who is marked do-not-call or has opted out.
 */
const MODULES = [
  { key: 'leads', title: 'Contacts → Buyer agent' },
  { key: 'properties', title: 'Inventories → Seller agent' },
] as const;
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']] as const;
const RUN_LABEL: Record<string, string> = { planning: 'Preparing', running: 'Calling', done: 'Finished', window_ended: 'Stopped at end of calling hours', failed: 'Could not run', nothing_to_call: 'Nobody to call' };

export default function AiCallingAdmin(): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['ai-calling-schedule'], queryFn: () => api.aiCallingSchedule(), refetchInterval: 30_000 });
  const status = useQuery({ queryKey: ['ai-calling-status'], queryFn: () => api.aiCallingStatus(), refetchInterval: 30_000 });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ['ai-calling-schedule'] }); void qc.invalidateQueries({ queryKey: ['ai-calling-status'] }); };

  const master = useMutation({
    mutationFn: (enabled: boolean) => api.saveAiCallingSchedule({ master: { enabled } }),
    onSuccess: refresh, onError: (e) => toast.error('Could not change the master switch', (e as Error).message),
  });

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;
  if (error || !data) return <div className="p-6"><p role="alert" className="text-sm">Could not load AI calling: {(error as Error | null)?.message}</p></div>;

  const turn = (on: boolean): void => {
    if (on && !window.confirm('Switch automatic AI calling ON?\n\nFrom the next start time, on the chosen days, the AI agent will ring real people on the lists you picked. Have you done a Preview and a small Run now first?')) return;
    master.mutate(on);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight"><Bot className="h-5 w-5" /> AI calling schedule</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The AI agent rings the right people by itself every day, inside calling hours ({data.policy.start}–{data.policy.end} India time),
          and never anybody who is marked do-not-call or has opted out. Results appear on each Contact and Inventory.
        </p>
      </div>

      {(data.health.sarvam || data.health.owner) && (
        <div role="alert" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>{data.health.sarvam && <p>{data.health.sarvam}</p>}{data.health.owner && <p>{data.health.owner} (Saving this page once as an admin fixes it.)</p>}</div>
        </div>
      )}

      <div className="card flex flex-wrap items-center gap-3 p-4">
        <Switch on={data.master.enabled} onChange={turn} label="Master switch" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Master switch: {data.master.enabled ? 'ON' : 'OFF'}</p>
          <p className="text-xs text-muted">{data.master.enabled ? 'Modules below that are switched on will start by themselves.' : 'Nothing is called automatically, whatever the settings below say.'}</p>
        </div>
      </div>

      <AiCallingProgress />

      {MODULES.map((m) => <ModuleCard key={m.key} title={m.title} s={data.modules[m.key]} onSaved={refresh} />)}

      <section className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold">Recent runs</h2>
        {!status.data?.runs.length ? <p className="text-sm text-muted">No runs yet.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted"><th className="py-1">Day</th><th>Module</th><th>How</th><th>Result</th><th>Queued</th><th>Left out</th></tr></thead>
            <tbody>
              {status.data.runs.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                  <td className="py-1">{r.run_date}</td><td>{r.module === 'leads' ? 'Contacts' : 'Inventories'}</td><td>{r.trigger === 'schedule' ? 'Automatic' : 'Run now'}</td>
                  <td>{RUN_LABEL[r.status] ?? r.status}{r.message ? <div className="text-muted">{r.message}</div> : null}</td>
                  <td>{r.planned}</td><td>{Object.values(r.skipped ?? {}).reduce((a, b) => a + b, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600')}>
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function ModuleCard({ title, s, onSaved }: { title: string; s: AiCallModuleSchedule; onSaved: () => void }): JSX.Element {
  const [draft, setDraft] = useState(s);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(s); }, [s, dirty]);
  const views = useQuery({ queryKey: ['ai-calling-views', s.module], queryFn: () => api.aiCallingViews(s.module) });
  const [preview, setPreview] = useState<AiCallPreview | null>(null);
  const [limit, setLimit] = useState(3);
  const set = (patch: Partial<AiCallModuleSchedule>): void => { setDraft({ ...draft, ...patch }); setDirty(true); };

  const save = useMutation({
    mutationFn: () => api.saveAiCallingSchedule({ modules: { [s.module]: {
      enabled: draft.enabled, startTime: draft.startTime, days: draft.days, dailyCap: draft.dailyCap, viewId: draft.viewId,
      restDays: draft.restDays, maxAttempts: draft.maxAttempts, retryHours: draft.retryHours } } }),
    onSuccess: () => { setDirty(false); toast.success('Saved'); onSaved(); },
    onError: (e) => toast.error('Could not save', (e as Error).message),
  });
  const look = useMutation({ mutationFn: () => api.aiCallingPreview(s.module), onSuccess: setPreview, onError: (e) => toast.error('Preview failed', (e as Error).message) });
  const run = useMutation({
    mutationFn: () => api.aiCallingRunNow(s.module, limit),
    onSuccess: (r) => { toast.success(r.planned ? `Queued ${r.planned} call${r.planned === 1 ? '' : 's'}` : 'Nobody to call', r.message ?? `They ring only during calling hours (${r.callingHours}).`); onSaved(); },
    onError: (e) => toast.error('Run failed', (e as Error).message),
  });
  const runNow = (): void => {
    if (dirty) { toast.error('Save your changes first', 'Run now uses the saved settings.'); return; }
    if (window.confirm(`Run now: the AI agent will call up to ${limit} REAL ${limit === 1 ? 'person' : 'people'} from the chosen list, during calling hours.\n\nIf you want to test, make sure the list holds only your own test records. Continue?`)) run.mutate();
  };

  return (
    <section className="card space-y-3 p-4" data-testid={`ai-calling-${s.module}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Switch on={draft.enabled} onChange={(on) => set({ enabled: on })} label={`${title} on or off`} />
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted">{s.blockedReason ? `Not running now: ${s.blockedReason}` : 'Running by itself today'}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Who can be called (a saved list)">
          <select className="input" value={draft.viewId ?? ''} onChange={(e) => set({ viewId: e.target.value || null })}>
            <option value="">— Pick a list (nobody is called until you do) —</option>
            {views.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="Start time (India)"><input className="input" type="time" value={draft.startTime} onChange={(e) => set({ startTime: e.target.value })} /></Field>
        <Field label="Days">
          <div className="flex flex-wrap gap-1">
            {DAYS.map(([n, name]) => {
              const on = draft.days.includes(n);
              return <button type="button" key={n} aria-pressed={on} onClick={() => set({ days: on ? draft.days.filter((d) => d !== n) : [...draft.days, n].sort() })}
                className={cn('rounded-md border px-2 py-1 text-xs', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300')}>{name}</button>;
            })}
          </div>
        </Field>
        <Field label="Most calls per day"><input className="input" type="number" min={1} max={500} value={draft.dailyCap} onChange={(e) => set({ dailyCap: Number(e.target.value) })} /></Field>
        <Field label="After a real conversation, leave them alone for (days)"><input className="input" type="number" min={0} max={365} value={draft.restDays} onChange={(e) => set({ restDays: Number(e.target.value) })} /></Field>
        <Field label="No answer or busy: try at most (times)"><input className="input" type="number" min={1} max={10} value={draft.maxAttempts} onChange={(e) => set({ maxAttempts: Number(e.target.value) })} /></Field>
        <Field label="…and wait at least (hours) between tries"><input className="input" type="number" min={1} max={240} value={draft.retryHours} onChange={(e) => set({ retryHours: Number(e.target.value) })} /></Field>
      </div>
      <p className="text-xs text-muted">Also skipped automatically: do-not-call and opted-out numbers, anyone already queued or on a call, a number already called today (several records with one number are one call), anyone with a follow-up booked for a later day, and anyone a team member spoke to in the last 2 days. Deal stages are left to the list you pick.</p>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <button className="btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button className="btn-secondary btn-sm" disabled={look.isPending} onClick={() => look.mutate()}><Eye className="h-3.5 w-3.5" /> Preview tomorrow&apos;s calls</button>
        <span className="ml-auto flex items-center gap-2 text-xs">
          Run now, at most <input aria-label="Run now limit" className="input h-7 w-16" type="number" min={1} max={25} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(25, Number(e.target.value) || 1)))} /> calls
          <button className="btn-secondary btn-sm" disabled={run.isPending} onClick={runNow}><Play className="h-3.5 w-3.5" /> Run now</button>
        </span>
      </div>

      {preview && <PreviewResult p={preview} />}
    </section>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return <label className="block space-y-1 text-xs"><span className="text-muted">{label}</span>{children}</label>;
}

function PreviewResult({ p }: { p: AiCallPreview }): JSX.Element {
  const masked = (phone: string): string => `${phone.slice(0, 3)} ••••• ${phone.slice(-3)}`;
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/40" data-testid="ai-calling-preview">
      <p className="font-semibold">Preview for {p.date}: {p.picks.length} would be called (looked at {p.considered}). Nobody has been called.</p>
      {p.problem && <p role="alert" className="text-amber-700">{p.problem}</p>}
      {p.picks.length > 0 && (
        <ul className="max-h-48 overflow-y-auto">
          {p.picks.map((c) => <li key={c.recordId} className="flex gap-2 border-t border-slate-200 py-1 dark:border-slate-700"><span className="min-w-0 flex-1 truncate">{c.label}</span><span className="text-muted">{masked(c.phone)}</span><span>{c.why}</span></li>)}
        </ul>
      )}
      {p.skipped.length > 0 && (
        <div>
          <p className="font-semibold">Left out, and why</p>
          <ul>{p.skipped.map((s) => <li key={s.reason}>{s.count} × {s.text}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
