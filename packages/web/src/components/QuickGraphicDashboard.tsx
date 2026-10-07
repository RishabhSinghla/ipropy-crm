import { type JSX, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import type { ListQuery } from '@ipropy/shared';
import { api } from '../lib/api';
import { CallDonut } from './CallDonut';
import { dashboardChoiceCondition } from '../lib/quickDashboardFilters';

type Period = '' | 'today' | 'yesterday' | 'this_week' | 'this_month';
const PERIODS = [{ value: '', label: 'Any date' }, { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'this_week', label: 'This week' }, { value: 'this_month', label: 'This month' }];

/** A temporary lens over the current module/list; never modifies a saved view. */
export function QuickGraphicDashboard({ module, label, context }: { module: string; label: string; context: ListQuery }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [created, setCreated] = useState<Period>('');
  const [changed, setChanged] = useState<Period>('');
  const [agent, setAgent] = useState('');
  const [agentBasis, setAgentBasis] = useState('owner_id');
  const [choices, setChoices] = useState<Record<string, string>>({});
  useEffect(() => { setSlot(document.getElementById('global-quick-dashboard')); }, []);
  useEffect(() => { setCreated(''); setChanged(''); setAgent(''); setChoices({}); }, [module]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const baseQuery = useMemo<ListQuery>(() => ({ view: context.view, search: context.search,
    filter: { logic: 'AND', conditions: [
      ...(context.filter ? [context.filter] : []),
      ...(created ? [{ field: 'created_at', operator: created }] : []),
      ...(changed ? [{ field: 'updated_at', operator: changed }] : []),
      ...(agent ? [{ field: agentBasis, operator: 'equals' as const, value: agent }] : []),
    ] },
  }), [context.view, context.search, context.filter, created, changed, agent, agentBasis]);
  // Keep options available when a combination returns zero records.
  const options = useQuery({ queryKey: ['dashboard', 'quick', module, baseQuery], queryFn: () => api.quickDashboard(module, baseQuery), enabled: open, refetchInterval: open ? 20000 : false });
  const query = useMemo<ListQuery>(() => {
    const selected = Object.entries(choices).filter(([, value]) => value).map(([field, value]) => dashboardChoiceCondition(field, value));
    return selected.length ? { ...baseQuery, filter: { logic: 'AND', conditions: [...(baseQuery.filter ? [baseQuery.filter] : []), ...selected] } } : baseQuery;
  }, [baseQuery, choices]);
  const data = useQuery({ queryKey: ['dashboard', 'quick', module, query], queryFn: () => api.quickDashboard(module, query), enabled: open, refetchInterval: open ? 20000 : false });
  const users = useQuery({ queryKey: ['users', 'quick-dashboard', module], queryFn: () => api.users(false, false, true, module), enabled: open });
  const filterClass = 'h-7 min-w-0 rounded-md border border-slate-200 bg-white px-1 text-[11px] dark:border-slate-700 dark:bg-slate-900';
  return <>
    {slot && createPortal(<button type="button" aria-label={open ? 'Close quick dashboard' : 'Open quick dashboard'} aria-expanded={open} aria-controls="quick-graphic-dashboard" className="btn-icon" onClick={() => setOpen(value => !value)}>{open ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}</button>, slot)}
    {open && createPortal(<section id="quick-graphic-dashboard" role="dialog" aria-label={`${label} quick dashboard`} className="fixed inset-x-0 top-14 z-50 h-auto max-h-[calc(100dvh-4rem)] overflow-auto border-b-2 border-brand-200 bg-slate-50 p-2 shadow-xl dark:border-brand-800 dark:bg-slate-950">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{label} · Quick dashboard</h2>
        <div className="flex flex-wrap gap-2 text-[11px]" aria-label="Dashboard record filters">
          {['Status', 'Call Log', 'Lost Reason', 'Tags'].map(title => {
            const chart = options.data?.charts.find(item => item.title === title);
            const field = chart?.field;
            return <select key={title} aria-label={`Dashboard ${title} filter`} className={filterClass} disabled={!field || chart?.unavailable} value={field ? choices[field] ?? '' : ''} onChange={e => field && setChoices(previous => ({ ...previous, [field]: e.target.value }))}>
              <option value="">{title}: {chart?.unavailable ? 'Not available' : 'All'}</option>
              {(chart?.options ?? chart?.slices ?? []).filter(item => item.key !== '__other').map(item => <option key={item.key} value={item.key}>{item.label} ({item.count.toLocaleString('en-IN')})</option>)}
            </select>;
          })}
          <span className="self-center text-brand-700 dark:text-brand-300" role="status">{data.data ? `${data.data.total.toLocaleString('en-IN')} records` : 'Loading…'}</span>
          {Object.values(choices).some(Boolean) && <button type="button" className="text-brand-700 underline dark:text-brand-300" onClick={() => setChoices({})}>Clear selections</button>}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <select aria-label="Dashboard created date" className={filterClass} value={created} onChange={e => setCreated(e.target.value as Period)}>{PERIODS.map(p => <option key={p.value} value={p.value}>{p.value ? p.label : 'Created: any date'}</option>)}</select>
          <select aria-label="Dashboard changed date" className={filterClass} value={changed} onChange={e => setChanged(e.target.value as Period)}>{PERIODS.map(p => <option key={p.value} value={p.value}>{p.value ? p.label : 'Changed: any date'}</option>)}</select>
          <select aria-label="Dashboard agent basis" className={filterClass} value={agentBasis} onChange={e => setAgentBasis(e.target.value)}><option value="owner_id">Assigned agent</option><option value="modified_by">Changed by agent</option></select>
          <select aria-label="Dashboard agent" className={filterClass} value={agent} onChange={e => setAgent(e.target.value)}><option value="">All agents</option>{users.data?.map(u => <option key={String(u.id)} value={String(u.id)}>{String(u.fullName ?? '')}</option>)}</select>
          <button type="button" className="btn-icon h-7 w-7" aria-label="Refresh quick dashboard" onClick={() => { void data.refetch(); if (query !== baseQuery) void options.refetch(); }} disabled={data.isFetching}><RefreshCw className="h-4 w-4" /></button>
          <button type="button" className="btn-icon h-7 w-7" aria-label="Close dashboard overlay" onClick={() => setOpen(false)}><ChevronUp className="h-4 w-4" /></button>
        </div>
      </div>
      {data.isError ? <p role="alert" className="text-sm text-red-600">Dashboard could not load. Your list is unchanged. Use Refresh to retry.</p> : data.data ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{data.data.charts.map(chart => <div key={chart.title} className="min-w-0">{chart.unavailable ? <div className="card p-2 text-xs">{chart.title}<p className="text-muted">Not available on this module/profile.</p></div> : <CallDonut compact unit={chart.title === 'Tags' ? 'tag links' : 'records'} title={chart.title === 'Tags' ? 'Tags · can overlap' : chart.title} slices={chart.slices.map(s => ({ ...s, selectable: false }))} selected="" onSelect={() => undefined} />}</div>)}</div> : <p role="status" className="text-sm">Loading live record counts…</p>}
      <p className="mt-1 text-[10px] text-muted">Current list and filters · Updates every 20 seconds while open · Dates use your CRM timezone · Charts show counts, not change-event totals</p>
    </section>, document.body)}
  </>;
}
