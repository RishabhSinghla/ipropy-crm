import { useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isLostStatus, statusFieldOf } from '@ipropy/shared';
import { Archive, RotateCcw, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useApp, toast } from '../lib/store';

export default function ArchivePage(): JSX.Element {
  const modules = useApp().modules.filter(module => module.isEntity);
  const [module, setModule] = useState(modules[0]?.name ?? 'leads');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const client = useQueryClient();
  const metadata = useQuery({ queryKey: ['module', module], queryFn: () => api.module(module) });
  const records = useQuery({ queryKey: ['archive', module, search, page], queryFn: () => api.list(module, { archive: true, search, page, pageSize: 50 }), refetchInterval: 30000 });
  const field = metadata.data && statusFieldOf(metadata.data.fields);
  const choices = field?.options?.filter(option => option.isActive !== false && !isLostStatus(option.value) && !isLostStatus(option.label)) ?? [];
  const reopen = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api.reopen(module, id, status),
    onSuccess: () => { void client.invalidateQueries(); toast.success('Record reopened'); }, onError: error => toast.error(error.message) });
  return <section className="flex h-full min-h-0 flex-col p-4">
    <h1 className="flex items-center gap-2 text-lg font-semibold"><Archive className="h-5 w-5" /> Archive</h1>
    <p className="my-2 text-xs text-muted">Lost records move here after 12 hours and are retained without automatic deletion. Open a record to send SMS, email or WhatsApp using your usual permissions. Reopen by choosing its new status.</p>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <select aria-label="Archived module" className="rounded-full border bg-white px-3 py-1 text-sm dark:bg-slate-900" value={module} onChange={event => { setModule(event.target.value); setPage(1); }}>{modules.map(item => <option key={item.name} value={item.name}>{item.label}</option>)}</select>
      <label className="flex items-center gap-2 rounded-full border px-3 py-1"><Search className="h-4 w-4" /><input aria-label="Search archived records" className="bg-transparent text-sm outline-none" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
      <span className="text-xs text-muted">{records.data?.total ?? 0} archived records</span>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      {records.isError ? <p role="alert">Archive could not load. Please try again.</p> : records.isLoading ? <p>Loading archive…</p> : !records.data?.rows.length ? <p className="p-8 text-center text-muted">No archived records match this module or search.</p> : records.data.rows.map(record => <div key={record.id} className="flex flex-wrap items-center gap-3 border-b py-3">
        <Link className="min-w-0 flex-1 font-semibold text-brand-700" to={`/${module}/${record.id}`}>{record.label} <span className="text-xs font-normal text-muted">{record.recordNumber}</span></Link>
        <select aria-label={`Reopen status for ${record.label}`} className="rounded-full border bg-white px-2 py-1 text-xs dark:bg-slate-900" value={statuses[record.id] ?? ''} onChange={event => setStatuses(previous => ({ ...previous, [record.id]: event.target.value }))}><option value="">Choose status…</option>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
        <button className="btn-secondary rounded-full text-xs" disabled={!statuses[record.id] || reopen.isPending} onClick={() => reopen.mutate({ id: record.id, status: statuses[record.id]! })}><RotateCcw className="h-3 w-3" /> Reopen</button>
      </div>)}
    </div>
    <div className="mt-2 flex items-center justify-end gap-3 text-xs"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>{page} / {Math.max(1, records.data?.totalPages ?? 1)}</span><button disabled={page >= (records.data?.totalPages ?? 1)} onClick={() => setPage(value => value + 1)}>Next</button></div>
  </section>;
}
