import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ChevronLeft, ChevronRight, Calendar, CheckCircle, AlertCircle, XCircle } from 'lucide-react';
import { formatIndianPrice, formatDate } from '@ipropy/shared';
import { api } from '../lib/api';
import { Card, Badge, Spinner, EmptyState, Select } from '../components/ui';
import { PortalLayout } from './PortalDashboard';

export default function PortalBookings(): JSX.Element {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['portalBookings', page, search, status],
    queryFn: () => api.portalBookings(page, pageSize),
  });

  if (isLoading) return <PortalLayout><Spinner className="mx-auto my-12 h-8 w-8" /></PortalLayout>;
  if (error) return <PortalLayout><EmptyState title="Could not load bookings" body={(error as Error).message} /></PortalLayout>;

  const rows = (data?.rows as { id: string; label: string; values: Record<string, unknown> }[]) ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <PortalLayout>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold">My Bookings</h2>
            <p className="text-sm text-slate-500">Confirmed bookings attributed to your portal account</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="search"
                className="input pl-9 w-64"
                placeholder="Search bookings…"
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
                { value: 'Booked', label: 'Booked' },
                { value: 'Agreement', label: 'Agreement' },
                { value: 'Registered', label: 'Registered' },
                { value: 'Cancelled', label: 'Cancelled' },
              ]}
            />
          </div>
        </div>

        <Card className="overflow-hidden">
          {isLoading ? (
            <div className="space-y-2 p-4">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse bg-slate-100 dark:bg-slate-800 rounded" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No bookings yet" body="Bookings will appear here when leads you submitted convert to confirmed sales." icon={<Calendar className="h-6 w-6" />} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/50">
                      <th className="table-head">Booking #</th>
                      <th className="table-head">Customer</th>
                      <th className="table-head">Project / Unit</th>
                      <th className="table-head">Agreement Value</th>
                      <th className="table-head">Status</th>
                      <th className="table-head">Booking Date</th>
                      <th className="table-head"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rows.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                        <td className="table-cell font-mono tnum">{String(r.values?.booking_number ?? '—')}</td>
                        <td className="table-cell">
                          <div className="font-medium">{String(r.values?.contact_id ?? '—')}</div>
                        </td>
                        <td className="table-cell text-slate-600 dark:text-slate-400">
                          {String(r.values?.project_id ?? '—')} / {String(r.values?.property_id ?? '—')}
                        </td>
                        <td className="table-cell tnum font-medium">{r.values?.agreement_value ? formatIndianPrice(Number(r.values.agreement_value)) : '—'}</td>
                        <td className="table-cell">
                          <Badge color={bookingStatusColor(String(r.values?.status))}>
                            {r.values?.status === 'Booked' && <CheckCircle className="h-3 w-3 mr-1" />}
                            {r.values?.status === 'Agreement' && <AlertCircle className="h-3 w-3 mr-1" />}
                            {r.values?.status === 'Registered' && <CheckCircle className="h-3 w-3 mr-1" />}
                            {r.values?.status === 'Cancelled' && <XCircle className="h-3 w-3 mr-1" />}
                            {String(r.values?.status ?? '—')}
                          </Badge>
                        </td>
                        <td className="table-cell text-2xs text-slate-500">{r.values?.booking_date ? formatDate(String(r.values.booking_date)) : '—'}</td>
                        <td className="table-cell"></td>
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

function bookingStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'booked') return '#3b82f6';
  if (s === 'agreement') return '#eab308';
  if (s === 'registered') return '#22c55e';
  if (s === 'cancelled') return '#ef4444';
  return '#64748b';
}