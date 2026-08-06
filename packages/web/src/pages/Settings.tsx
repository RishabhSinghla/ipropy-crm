import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Monitor, Moon, Save, Sun, User } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { Avatar, Badge, Select, Skeleton, Spinner, Tabs } from '../components/ui';

export default function SettingsPage(): JSX.Element {
  const { user, theme, setTheme } = useApp();
  const [tab, setTab] = useState('profile');

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-slate-500">Your profile, preferences and security.</p>
      </div>

      <Tabs
        tabs={[
          { key: 'profile', label: 'Profile', icon: <User className="h-3.5 w-3.5" /> },
          { key: 'preferences', label: 'Preferences', icon: <Monitor className="h-3.5 w-3.5" /> },
          { key: 'security', label: 'Security', icon: <KeyRound className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'profile' && <ProfileTab />}
      {tab === 'preferences' && <PreferencesTab theme={theme} setTheme={setTheme} />}
      {tab === 'security' && <SecurityTab />}
    </div>
  );
}

function ProfileTab(): JSX.Element {
  const { user, bootstrap } = useApp();
  const [form, setForm] = useState({
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    phone: user?.phone ?? '',
    extension: user?.extension ?? '',
  });
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.updateProfile(form);
      toast.success('Profile updated');
      await bootstrap();
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-5">
      <div className="mb-5 flex items-center gap-4">
        <Avatar name={user?.fullName ?? ''} src={user?.avatarUrl} size={56} />
        <div>
          <p className="text-base font-semibold">{user?.fullName}</p>
          <p className="text-sm text-slate-500">{user?.email}</p>
          <div className="mt-1 flex gap-1.5">
            {user?.roleName && <Badge>{user.roleName}</Badge>}
            {user?.profileName && <Badge color="#6366f1">{user.profileName}</Badge>}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">First name</label>
          <input className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </div>
        <div>
          <label className="label">Last name</label>
          <input className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </div>
        <div>
          <label className="label">Phone</label>
          <input className="input tnum" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <p className="mt-1 text-2xs text-slate-400">Click-to-call rings this number first.</p>
        </div>
        <div>
          <label className="label">Extension</label>
          <input className="input tnum" value={form.extension} onChange={(e) => setForm({ ...form, extension: e.target.value })} />
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button onClick={() => void save()} disabled={saving} className="btn-primary">
          {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save profile
        </button>
      </div>
    </div>
  );
}

function PreferencesTab({
  theme, setTheme,
}: { theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void }): JSX.Element {
  const { user, bootstrap } = useApp();
  const [defaultDashboardId, setDefaultDashboardId] = useState(user?.defaultDashboardId ?? '');
  const { data: dashboards } = useQuery({ queryKey: ['dashboards'], queryFn: () => api.dashboards() });

  return (
    <div className="card space-y-5 p-5">
      <div>
        <p className="mb-2 text-sm font-medium">Appearance</p>
        <div className="flex gap-2">
          {([
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
          ] as const).map((option) => (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={cn(
                'flex flex-1 flex-col items-center gap-2 rounded-lg border p-4 transition-colors',
                theme === option.value
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/50'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
              )}
            >
              <option.icon className="h-5 w-5" />
              <span className="text-sm font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Default dashboard</label>
        <Select
          value={defaultDashboardId}
          onChange={(id) => {
            setDefaultDashboardId(id);
            void api.updateProfile({ defaultDashboardId: id || null })
              .then(() => { toast.success('Default dashboard updated'); void bootstrap(); });
          }}
          placeholder="— System default —"
          options={(dashboards ?? []).map((d) => ({ value: d.id, label: d.name }))}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">Timezone</label>
          <input className="input" value={user?.timezone ?? ''} disabled />
        </div>
        <div>
          <label className="label">Locale</label>
          <input className="input" value={user?.locale ?? ''} disabled />
        </div>
        <div>
          <label className="label">Currency</label>
          <input className="input" value={user?.currency ?? ''} disabled />
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Timezone, locale and currency are set organisation-wide by an administrator.
      </p>
    </div>
  );
}

function SecurityTab(): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: sessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.request<Record<string, unknown>[]>('/api/auth/sessions'),
  });

  const change = async (): Promise<void> => {
    if (next !== confirm) { toast.error('Passwords do not match'); return; }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast.success('Password changed', 'Other devices were signed out.');
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      toast.error('Could not change the password', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="mb-3 text-sm font-medium">Change password</p>
        <div className="space-y-3">
          <div>
            <label className="label">Current password</label>
            <input type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">New password</label>
              <input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            </div>
            <div>
              <label className="label">Confirm new password</label>
              <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
          <p className="text-2xs text-slate-500">
            At least 8 characters, with upper case, lower case and a number.
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => void change()}
            disabled={busy || !current || next.length < 8}
            className="btn-primary"
          >
            {busy && <Spinner />} Change password
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <p className="text-sm font-medium">Active sessions</p>
        </div>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {(sessions ?? []).slice(0, 8).map((raw) => {
            const s = raw as { id: string; user_agent: string | null; ip_address: string | null; created_at: string; revoked_at: string | null };
            return (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <Monitor className="h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{s.user_agent ?? 'Unknown device'}</p>
                  <p className="text-2xs text-slate-400 tnum">
                    {s.ip_address} · {new Date(s.created_at).toLocaleString('en-IN')}
                  </p>
                </div>
                {s.revoked_at && <Badge color="#94a3b8">Revoked</Badge>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
