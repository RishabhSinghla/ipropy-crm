import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Users, Calendar, FileText, Home, DollarSign, Briefcase, ChevronRight } from 'lucide-react';
import { formatIndianPrice } from '@ipropy/shared';
import { api } from '../lib/api';
import { Card, Badge, Spinner, EmptyState } from '../components/ui';
import { useApp } from '../lib/store';

export function PortalLayout({ children }: { children: JSX.Element }): JSX.Element {
  const { user, logout } = useApp();
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-7xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-600 text-white">
              <Briefcase className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Partner Portal</h1>
              <p className="text-sm text-muted">{user?.fullName} · {user?.channelPartnerId ? 'Linked' : 'Unlinked'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={logout} className="btn-ghost btn-sm">Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: React.ComponentType<{ className?: string }>; color: string }): JSX.Element {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted">{label}</p>
          <p className="mt-1 text-2xl font-semibold tnum">{value}</p>
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>
    </Card>
  );
}

export default function PortalDashboard(): JSX.Element {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['portalOverview'],
    queryFn: () => api.portalOverview(),
  });

  if (isLoading) return <Spinner className="mx-auto my-12 h-8 w-8" />;
  if (error) return <EmptyState title="Could not load portal" body={(error as Error).message} />;

  const partner = data?.partner as Record<string, unknown> | undefined;
  const stats = data?.stats as { leads: number; siteVisits: number; bookings: number; agreementValue: number; commission: number } | undefined;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">{String(partner?.name ?? 'Partner Portal')}</h2>
        <p className="mt-1 text-slate-500">{String(partner?.firm_name ?? '')} · {String(partner?.tier ?? '')} Tier</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Leads" value={stats?.leads ?? 0} icon={Users} color="bg-blue-500" />
        <StatCard label="Site Visits" value={stats?.siteVisits ?? 0} icon={Calendar} color="bg-green-500" />
        <StatCard label="Bookings" value={stats?.bookings ?? 0} icon={FileText} color="bg-amber-500" />
        <StatCard label="Total Value" value={formatIndianPrice(stats?.agreementValue)} icon={DollarSign} color="bg-purple-500" />
        <StatCard label="Commission" value={formatIndianPrice(stats?.commission)} icon={Home} color="bg-emerald-500" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="font-semibold mb-3">Quick Actions</h3>
          <div className="space-y-2">
            <button onClick={() => navigate('/portal/leads/new')} className="btn-primary w-full justify-start gap-3">
              <Users className="h-4 w-4" /> Submit a New Enquiry
            </button>
            <button onClick={() => navigate('/portal/leads')} className="btn-secondary w-full justify-start gap-3">
              <ArrowRight className="h-4 w-4" /> View My Leads
            </button>
            <button onClick={() => navigate('/portal/bookings')} className="btn-secondary w-full justify-start gap-3">
              <FileText className="h-4 w-4" /> View Bookings
            </button>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold mb-3">Recent Leads</h3>
          <PortalRecentLeads />
        </Card>
      </div>
    </div>
  );
}

function PortalRecentLeads(): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['portalLeads', 1],
    queryFn: () => api.portalLeads(1, 5),
  });

  if (isLoading) return <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse bg-slate-100 dark:bg-slate-800 rounded" />)}</div>;

  const rows = data?.rows ?? [];
  if (!rows.length) return <p className="text-sm text-muted">No leads submitted yet.</p>;

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
          <div className="min-w-0">
            <p className="font-medium truncate">{r.label}</p>
            <p className="text-2xs text-muted">{String(r.values?.status ?? 'New')}</p>
          </div>
          <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
        </li>
      ))}
    </ul>
  );
}