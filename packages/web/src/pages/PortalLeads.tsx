import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { formatIndianPrice, formatDate } from '@ipropy/shared';
import { api } from '../lib/api';
import { Card, Badge, Spinner, EmptyState, Select } from '../components/ui';
import { PortalLayout } from './PortalDashboard';

export default function PortalLeads(): JSX.Element {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['portalLeads', page, search, status],
    queryFn: () => api.portalLeads(page, pageSize),
  });

  if (isLoading) return <PortalLayout><Spinner className="mx-auto my-12 h-8 w-8" /></PortalLayout>;
  if (error) return <PortalLayout><EmptyState title="Could not load leads" body={(error as Error).message} /></PortalLayout>;

  const rows = (data?.rows as { id: string; label: string; values: Record<string, unknown> }[]) ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <PortalLayout>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold">My Leads</h2>
            <p className="text-sm text-slate-500">Enquiries submitted through the partner portal</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="search"
                className="input pl-9 w-64"
                placeholder="Search leads…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select
              value={status}
              onChange={setStatus}
              placeholder="All statuses"
              options={[
                { value: '', label: 'All statuses' },
                { value: 'New', label: 'New' },
                { value: 'Contacted', label: 'Contacted' },
                { value: 'Qualified', label: 'Qualified' },
                { value: 'Site Visit Done', label: 'Site Visit Done' },
                { value: 'Booking', label: 'Booking' },
                { value: 'Lost', label: 'Lost' },
              ]}
            />
            <button onClick={() => navigate('/portal/leads/new')} className="btn-primary btn-sm">
              <span>New Enquiry</span>
            </button>
          </div>
        </div>

        <Card className="overflow-hidden">
          {isLoading ? (
            <div className="space-y-2 p-4">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse bg-slate-100 dark:bg-slate-800 rounded" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No leads yet" body="Submit your first enquiry from the dashboard or the quick actions." icon={<Search className="h-6 w-6" />} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/50">
                      <th className="table-head">Lead</th>
                      <th className="table-head">Status</th>
                      <th className="table-head">Project</th>
                      <th className="table-head">Budget</th>
                      <th className="table-head">Created</th>
                      <th className="table-head"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rows.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                        <td className="table-cell">
                          <div className="font-medium">{r.label}</div>
                          <div className="text-2xs text-slate-500">{String(r.values?.mobile ?? r.values?.email ?? '—')}</div>
                        </td>
                        <td className="table-cell">
                          <Badge color={statusColor(String(r.values?.status))}>{String(r.values?.status ?? 'New')}</Badge>
                        </td>
                        <td className="table-cell text-slate-600 dark:text-slate-400">
                          {r.values?.interested_project_id ? 'Linked' : '—'}
                        </td>
                        <td className="table-cell tnum">
                          {r.values?.budget_min || r.values?.budget_max
                            ? `${r.values?.budget_min ? formatIndianPrice(Number(r.values.budget_min)) : '—'} – ${r.values?.budget_max ? formatIndianPrice(Number(r.values.budget_max)) : '—'}`
                            : '—'}
                        </td>
                        <td className="table-cell text-2xs text-slate-500">{r.values?.created_at ? formatDate(String(r.values.created_at)) : '—'}</td>
                        <td className="table-cell">
                          <button className="btn-ghost p-1.5" title="View">
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
                  <p className="text-xs text-slate-500 tnum">
                    {((page - 1) * pageSize + 1).toLocaleString('en-IN')}–{Math.min(page * pageSize, total).toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}
                  </p>
                  <div className="flex items-center gap-1">
                    <button className="btn-ghost p-1.5 disabled:opacity-30" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></button>
                    <span className="px-2 text-xs text-slate-600 tnum dark:text-slate-400">{page} / {totalPages}</span>
                    <button className="btn-ghost p-1.5 disabled:opacity-30" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </PortalLayout>
  );
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'new') return '#3b82f6';
  if (s === 'contacted') return '#06b6d4';
  if (s === 'qualified') return '#a855f7';
  if (s.includes('site visit')) return '#eab308';
  if (s === 'booking') return '#22c55e';
  if (s === 'lost') return '#ef4444';
  return '#64748b';
}