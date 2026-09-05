import { type JSX, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  Bell, BellOff, Camera, Check, Copy, Download, Fingerprint, KeyRound, Monitor,
  Moon, Plus, Save, Smartphone, Sun, Trash2, User,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { currentSubscription, disablePush, enablePush, permissionState, pushSupport } from '../lib/push';
import { Avatar, Badge, ConfirmDialog, EmptyState, Modal, Select, Skeleton, Spinner, Tabs } from '../components/ui';

export default function SettingsPage(): JSX.Element {
  const { theme, setTheme } = useApp();
  const [tab, setTab] = useState('profile');

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted">Your profile, preferences and security.</p>
      </div>

      <Tabs
        tabs={[
          { key: 'profile', label: 'Profile', icon: <User className="h-3.5 w-3.5" /> },
          { key: 'preferences', label: 'Preferences', icon: <Monitor className="h-3.5 w-3.5" /> },
          { key: 'alerts', label: 'Alerts', icon: <Bell className="h-3.5 w-3.5" /> },
          { key: 'security', label: 'Security', icon: <KeyRound className="h-3.5 w-3.5" /> },
          { key: 'phones', label: 'Phones', icon: <Smartphone className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'profile' && <ProfileTab />}
      {tab === 'preferences' && <PreferencesTab theme={theme} setTheme={setTheme} />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'phones' && <PhonesTab />}
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
      <div className="mb-5 flex items-start gap-4">
        <AvatarPicker />
        <div className="min-w-0">
          <p className="text-base font-semibold">{user?.fullName}</p>
          <p className="truncate text-sm text-muted">{user?.email}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
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
          <p className="mt-1 text-2xs text-muted">Click-to-call rings this number first.</p>
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
      <p className="text-xs text-muted">
        Timezone, locale and currency are set organisation-wide by an administrator.
      </p>
    </div>
  );
}

function SecurityTab(): JSX.Element {
  const queryClient = useQueryClient();
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
      toast.success('Password changed', 'Other sessions were signed out and trusted-device PINs were reset.');
      setCurrent(''); setNext(''); setConfirm('');
      await queryClient.invalidateQueries({ queryKey: ['pin-devices'] });
      await queryClient.invalidateQueries({ queryKey: ['pin-status'] });
    } catch (err) {
      toast.error('Could not change the password', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PasskeysCard />
      <DevicePinCard />
      <ConnectedAppsCard />

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
          <p className="text-2xs text-muted">
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
                  <p className="text-2xs text-muted tnum">
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

/**
 * Keys that let something outside the CRM act as you — an AI assistant, a
 * phone shortcut, a script.
 *
 * The key is shown once, on creation, and only ever stored hashed. That is not
 * theatre: this string is a password with no second factor, and a list that can
 * re-display it turns one glance at a screen into permanent access to a
 * colleague's pipeline.
 *
 * What a key can do is deliberately narrower than what you can do in the CRM:
 * it reads, creates and updates records you already have access to, and that is
 * all. It cannot administer the CRM, change fields or delete anything — see
 * `blockApiKey` in the server's auth middleware.
 */
function ConnectedAppsCard(): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  const { data: keys, refetch } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.apiKeys(),
  });

  const create = async (): Promise<void> => {
    if (!name.trim()) { toast.error('Give the key a name so you know what to revoke later'); return; }
    setBusy(true);
    try {
      const created = await api.createApiKey(name.trim());
      setFresh({ name: created.name, key: created.key });
      setName('');
      setCopied(false);
      await refetch();
    } catch (err) {
      toast.error('Could not create the key', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    try {
      await api.revokeApiKey(id);
      toast.success('Key revoked', 'Anything using it stops working immediately.');
      await refetch();
    } catch (err) {
      toast.error('Could not revoke the key', (err as Error).message);
    }
  };

  const live = (keys ?? []).filter((k) => !k.revoked_at);

  return (
    <div className="card p-5">
      <p className="text-sm font-medium">Connected apps</p>
      <p className="mt-1 text-xs text-muted">
        A key lets an assistant like Claude or ChatGPT work with your CRM records. It can read,
        add and update — the same records you can see, and nothing more. It can never delete
        anything or reach the admin area.
      </p>

      {fresh && (
        <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50 p-3 dark:border-brand-900 dark:bg-brand-950/40">
          <p className="text-xs font-medium">Copy “{fresh.name}” now — it is not shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-2xs dark:bg-slate-900">
              {fresh.key}
            </code>
            <button
              className="btn-secondary btn-sm shrink-0"
              onClick={() => {
                void navigator.clipboard.writeText(fresh.key).then(() => {
                  setCopied(true);
                  toast.success('Copied');
                });
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button className="mt-2 text-2xs text-muted hover:underline" onClick={() => setFresh(null)}>
            I have saved it — hide this
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <label className="label" htmlFor="api-key-name">What is it for?</label>
          <input
            id="api-key-name"
            className="input"
            placeholder="e.g. Claude on my laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
        </div>
        <button className="btn-primary btn-sm" disabled={busy} onClick={() => void create()}>
          {busy ? <Spinner className="h-3 w-3" /> : <Plus className="h-3.5 w-3.5" />} Create key
        </button>
      </div>

      {live.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          {live.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{k.name}</p>
                <p className="text-2xs text-muted">
                  <span className="font-mono">{k.key_prefix}…</span>
                  {' · '}
                  {k.last_used_at ? `last used ${relativeTime(k.last_used_at)}` : 'never used'}
                </p>
              </div>
              <button
                className="btn-ghost p-1 text-slate-400 hover:text-red-500"
                title={`Revoke ${k.name}`}
                onClick={() => setRevoking({ id: k.id, name: k.name })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(revoking)}
        title={`Revoke “${revoking?.name}”?`}
        body="Whatever is using this key stops working straight away. You can always create another."
        confirmLabel="Revoke"
        danger
        onConfirm={() => { const id = revoking?.id; setRevoking(null); if (id) void revoke(id); }}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}

/**
 * Optional banking-app-style quick unlock. The four digits are useful only
 * together with this browser's HttpOnly random device credential; they are
 * never accepted as an account-wide password.
 */
function DevicePinCard(): JSX.Element {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const { data: devices, refetch } = useQuery({
    queryKey: ['pin-devices'],
    queryFn: () => api.pinDevices(),
  });

  const setDigits = (value: string, setter: (next: string) => void): void => {
    setter(value.replace(/\D/g, '').slice(0, 4));
  };

  const enrol = async (): Promise<void> => {
    if (pin.length !== 4) { toast.error('Enter exactly four digits'); return; }
    if (pin !== confirm) { toast.error('PINs do not match'); return; }
    setBusy(true);
    try {
      await api.enrolPin(pin, password, describeThisDevice());
      setPin(''); setConfirm(''); setPassword('');
      toast.success('Quick unlock is ready', 'It works only in this browser on this device.');
      await refetch();
    } catch (err) {
      toast.error('Could not set up the PIN', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api.deletePinDevice(id);
      toast.success('Trusted device removed');
      await refetch();
    } catch (err) {
      toast.error('Could not remove the device', (err as Error).message);
    }
  };

  return (
    <div className="card space-y-4 p-5">
      <div>
        <p className="text-sm font-medium">Four-digit quick unlock</p>
        <p className="mt-1 text-sm text-muted">
          Optional. The PIN is tied to this trusted browser, locks after five wrong attempts,
          and cannot be used from another phone or computer.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">New 4-digit PIN</label>
          <input
            type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4}
            className="input text-center tracking-[0.45em] tnum" value={pin}
            onChange={(e) => setDigits(e.target.value, setPin)} autoComplete="off" placeholder="••••"
          />
        </div>
        <div>
          <label className="label">Confirm PIN</label>
          <input
            type="password" inputMode="numeric" pattern="[0-9]*" maxLength={4}
            className="input text-center tracking-[0.45em] tnum" value={confirm}
            onChange={(e) => setDigits(e.target.value, setConfirm)} autoComplete="off" placeholder="••••"
          />
        </div>
        <div>
          <label className="label">Current password</label>
          <input
            type="password" className="input" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="Required once"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary btn-sm" disabled={busy || pin.length !== 4 || confirm.length !== 4 || !password} onClick={() => void enrol()}>
          {busy ? <Spinner className="h-3 w-3" /> : <KeyRound className="h-3.5 w-3.5" />}
          Trust this device
        </button>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Devices with quick unlock</p>
        {(devices ?? []).length === 0 ? (
          <p className="text-xs text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {(devices ?? []).map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">
                    {device.label ?? 'Unnamed device'}{device.is_current ? ' · this browser' : ''}
                  </p>
                  <p className="text-2xs text-muted">
                    added {relativeTime(device.created_at)}
                    {device.last_used_at ? ` · last used ${relativeTime(device.last_used_at)}` : ' · never used'}
                    {device.locked_until && new Date(device.locked_until) > new Date() ? ' · temporarily locked' : ''}
                  </p>
                </div>
                <button className="btn-ghost btn-sm shrink-0 text-negative" onClick={() => void remove(device.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Turn browser alerts on for this device.
 *
 * Per device, not per account: someone can want alerts on their phone and not
 * on the shared desk machine, and the browser's subscription is per
 * device+origin anyway. The device list makes that visible, because "I turned
 * notifications on, why is nothing arriving" is otherwise unanswerable.
 */
function AlertsTab(): JSX.Element {
  const [support] = useState(() => pushSupport());
  const [permission, setPermission] = useState(() => permissionState());
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: devices, refetch: refetchDevices } = useQuery({
    queryKey: ['push-devices'],
    queryFn: () => api.pushDevices(),
  });

  useEffect(() => {
    void currentSubscription().then((sub) => setSubscribed(Boolean(sub)));
  }, []);

  const enable = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await enablePush();
      setPermission(permissionState());
      if (result.ok) {
        setSubscribed(true);
        toast.success(result.message);
        await refetchDevices();
      } else {
        toast.error('Could not turn on alerts', result.message);
      }
    } catch (err) {
      toast.error('Could not turn on alerts', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    setBusy(true);
    try {
      await disablePush();
      setSubscribed(false);
      toast.success('Alerts turned off for this device');
      await refetchDevices();
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    const result = await api.pushTest();
    if (result.ok) toast.success('Test sent', result.message);
    else toast.error('Nothing to send to', result.message);
  };

  return (
    <div className="card space-y-5 p-5">
      <div>
        <p className="text-sm font-medium">Alerts on this device</p>
        <p className="mt-1 text-sm text-muted">
          Get a notification the moment a lead arrives or is assigned to you — even with the
          CRM closed.
        </p>
      </div>

      {!support.supported ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {support.reason === 'ios-needs-install'
            ? 'On iPhone and iPad, alerts only work once iPropy is added to the Home Screen. Tap Share → Add to Home Screen, open it from there, then come back to this page.'
            : support.reason === 'insecure'
              ? 'Alerts need a secure (https) connection.'
              : 'This browser cannot receive push notifications.'}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {subscribed ? (
            <>
              <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void disable()}>
                {busy && <Spinner className="h-3 w-3" />}<BellOff className="h-3.5 w-3.5" /> Turn off alerts
              </button>
              <button className="btn-secondary btn-sm" onClick={() => void sendTest()}>
                Send a test
              </button>
              <Badge color="#22c55e">On for this device</Badge>
            </>
          ) : (
            <button className="btn-primary btn-sm" disabled={busy} onClick={() => void enable()}>
              {busy && <Spinner className="h-3 w-3" />}<Bell className="h-3.5 w-3.5" /> Turn on alerts
            </button>
          )}
        </div>
      )}

      {permission === 'denied' && (
        <p className="text-xs text-negative">
          This site is blocked from sending notifications. Allow them in your browser’s site
          settings (the icon at the left of the address bar), then reload.
        </p>
      )}

      <div>
        <p className="mb-2 text-sm font-medium">Devices receiving alerts</p>
        {(devices ?? []).length === 0 ? (
          <p className="text-xs text-muted">No devices yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {(devices ?? []).map((raw) => {
              const d = raw as { id: string; user_agent: string | null; created_at: string; last_used_at: string | null };
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-xs">{describeDevice(d.user_agent)}</span>
                  <span className="shrink-0 text-2xs text-muted">
                    {d.last_used_at ? `last alert ${relativeTime(d.last_used_at)}` : 'no alerts yet'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A user-agent string is unreadable; this is enough to tell your devices apart. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const os = /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent) ? 'iPhone / iPad'
    : /Macintosh/i.test(userAgent) ? 'Mac'
    : /Windows/i.test(userAgent) ? 'Windows'
    : /Linux/i.test(userAgent) ? 'Linux' : 'Unknown';
  const browser = /Edg\//i.test(userAgent) ? 'Edge'
    : /OPR\//i.test(userAgent) ? 'Opera'
    : /Firefox\//i.test(userAgent) ? 'Firefox'
    : /Chrome\//i.test(userAgent) ? 'Chrome'
    : /Safari\//i.test(userAgent) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}

/**
 * Set, replace or remove your own photo.
 *
 * The image goes through the same attachment pipeline as any other upload, so
 * it inherits the derivative generation — `Avatar` then requests the `thumb`
 * variant rather than pulling a 4MB phone photo down for a 32px circle.
 * `avatar_url` holds the path; removing simply clears it and the initials
 * fallback returns, so nothing is orphaned mid-change.
 */
function AvatarPicker(): JSX.Element {
  const { user, bootstrap } = useApp();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      toast.error('Choose an image', `${file.name} is not a picture.`);
      return;
    }
    setBusy(true);
    try {
      const { url } = await api.uploadFile(file);
      await api.updateProfile({ avatarUrl: url });
      await bootstrap();
      toast.success('Photo updated');
    } catch (err) {
      toast.error('Could not update your photo', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.updateProfile({ avatarUrl: null });
      await bootstrap();
      toast.success('Photo removed');
    } catch (err) {
      toast.error('Could not remove your photo', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 text-center">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="group relative block rounded-full"
        aria-label={user?.avatarUrl ? 'Change your photo' : 'Add a photo'}
      >
        <Avatar name={user?.fullName ?? ''} src={user?.avatarUrl} size={64} />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-slate-900/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {busy ? <Spinner className="h-4 w-4 text-white" /> : <Camera className="h-4 w-4 text-white" />}
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void choose(f);
          // Reset so picking the same file twice still fires a change event.
          e.target.value = '';
        }}
      />

      <div className="mt-1.5 flex items-center justify-center gap-2 text-2xs">
        <button type="button" className="text-brand-600 hover:underline dark:text-brand-400" disabled={busy} onClick={() => inputRef.current?.click()}>
          {user?.avatarUrl ? 'Change' : 'Add photo'}
        </button>
        {user?.avatarUrl && (
          <button type="button" className="text-negative hover:underline" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Face ID / Touch ID / Android biometrics, per device.
 *
 * A passkey lives in the phone's secure enclave; the fingerprint never reaches
 * us and the server only holds a public key. It is also phishing-resistant —
 * the credential is bound to this origin and will not sign for another one —
 * which is worth more here than the convenience, given what a CRM holds.
 */
function PasskeysCard(): JSX.Element {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: passkeys, refetch } = useQuery({ queryKey: ['passkeys'], queryFn: () => api.passkeys() });

  useEffect(() => {
    if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return;
    void window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .then(setSupported).catch(() => setSupported(false));
  }, []);

  const enrol = async (): Promise<void> => {
    setBusy(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const options = await api.passkeyRegisterOptions();
      const attestation = await startRegistration({ optionsJSON: options as never });
      await api.passkeyRegisterVerify(attestation, describeThisDevice());
      toast.success('This device can now sign you in', 'Face ID, Touch ID or your fingerprint.');
      await refetch();
    } catch (err) {
      const name = (err as { name?: string }).name;
      // Cancelling the prompt is a choice, not a failure.
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        toast.error('Could not set up biometric sign-in', (err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await api.deletePasskey(id);
    toast.success('Device removed');
    await refetch();
  };

  return (
    <div className="card space-y-4 p-5">
      <div>
        <p className="text-sm font-medium">Face ID &amp; fingerprint sign-in</p>
        <p className="mt-1 text-sm text-muted">
          Sign in with your face or fingerprint instead of typing a password. The scan stays on
          your device — iPropy only ever receives a key it can check.
        </p>
      </div>

      {!supported ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          This browser does not currently advertise a built-in biometric authenticator. You can
          still use your password or set up a device-bound quick PIN below.
        </div>
      ) : (
        <button className="btn-primary btn-sm" disabled={busy} onClick={() => void enrol()}>
          {busy ? <Spinner className="h-3 w-3" /> : <Fingerprint className="h-3.5 w-3.5" />}
          Set up on this device
        </button>
      )}

      <div>
        <p className="mb-2 text-sm font-medium">Devices that can sign in</p>
        {(passkeys ?? []).length === 0 ? (
          <p className="text-xs text-muted">None yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {(passkeys ?? []).map((raw) => {
              const k = raw as { id: string; device_label: string | null; created_at: string; last_used_at: string | null };
              return (
                <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{k.device_label ?? 'Unnamed device'}</p>
                    <p className="text-2xs text-muted">
                      added {relativeTime(k.created_at)}
                      {k.last_used_at ? ` · last used ${relativeTime(k.last_used_at)}` : ' · never used'}
                    </p>
                  </div>
                  <button className="btn-ghost btn-sm shrink-0 text-negative" onClick={() => void remove(k.id)}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A label the owner will recognise in the device list. */
function describeThisDevice(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : 'This device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

/**
 * Download the Android app.
 *
 * Sits above pairing because that is the order the work happens in: a rep
 * cannot paste a pairing token into an app that is not on the phone yet. The
 * commonest way to do this is to open the CRM on the handset itself and tap
 * the button, which is why the link is a plain anchor to a public address
 * rather than anything that needs a signed-in fetch.
 */
function GetTheApp(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['companion-build'],
    queryFn: () => api.companionBuild(),
    staleTime: 5 * 60_000,
  });

  // Nothing at all rather than a broken button when no build has been
  // published. A greyed-out control here would only raise a question that
  // nobody reading this screen can answer.
  if (!data?.available || !data.build) return null;

  const megabytes = (data.build.sizeBytes / 1024 / 1024).toFixed(1);

  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-sm font-medium">iPropy Companion for Android</p>
          <p className="mt-1 text-sm text-muted">
            Install this on a rep&apos;s phone and their calls, call recordings and, if you have
            switched it on, their position reach the CRM on their own. Open this page on the
            handset itself and tap the button; that is the quickest way.
          </p>
          <p className="mt-2 text-2xs text-muted">
            Version {data.build.versionName} · {megabytes} MB · Android {androidNameFor(data.build.minSdk)} or newer
          </p>
        </div>
        <a href={data.url} className="btn-primary btn-sm shrink-0" download>
          <Download className="h-3.5 w-3.5" /> Download the app
        </a>
      </div>

      <ol className="space-y-2 border-t border-slate-100 pt-4 text-sm text-muted dark:border-slate-800">
        <li>
          <span className="font-medium text-slate-700 dark:text-slate-200">1. Let the phone install it.</span>{' '}
          Android will warn that the file came from outside the Play Store. Choose Settings on that
          warning and allow your browser to install apps, then tap the downloaded file again.
        </li>
        <li>
          <span className="font-medium text-slate-700 dark:text-slate-200">2. Pair it.</span>{' '}
          Tap <em>Pair a phone</em> below, copy the token, and paste it into the app&apos;s
          &quot;Pair this device&quot; screen along with this CRM&apos;s web address.
        </li>
        <li>
          <span className="font-medium text-slate-700 dark:text-slate-200">3. Say yes to the permissions.</span>{' '}
          Call log, notifications and location. Location needs a second step that Android will not
          let the app ask for in a pop-up: open the app&apos;s own Settings page and change location
          from &quot;While using the app&quot; to &quot;Allow all the time&quot;. The app offers to
          take you there.
        </li>
        <li>
          <span className="font-medium text-slate-700 dark:text-slate-200">4. On Xiaomi, Oppo, Vivo or Realme, turn on Autostart.</span>{' '}
          In the phone&apos;s own app settings, switch Autostart on and set battery to No
          restrictions. Skip this and the phone stops reporting a day or two later with nothing to
          show why.
        </li>
      </ol>
    </div>
  );
}

/** The Android release a minimum SDK level corresponds to, for people rather than build tools. */
function androidNameFor(minSdk: number): string {
  const names: Record<number, string> = { 24: '7', 26: '8', 28: '9', 29: '10', 30: '11', 31: '12', 33: '13', 34: '14' };
  return names[minSdk] ?? String(minSdk);
}

function PhonesTab(): JSX.Element {
  const { user } = useApp();
  const [pairOpen, setPairOpen] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const { data: devices, isLoading, refetch } = useQuery({
    queryKey: ['device-phones'],
    queryFn: () => api.devices(),
  });

  const revokeNow = async (): Promise<void> => {
    if (!revoking) return;
    await api.revokeDevice(revoking.id);
    toast.success('Device revoked', 'It can no longer sync calls.');
    setRevoking(null);
    await refetch();
  };

  return (
    <div className="space-y-4">

    <GetTheApp />

    <div className="card space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-sm font-medium">Call-logging phones</p>
          <p className="mt-1 text-sm text-muted">
            Calls made or received on these handsets appear in the CRM automatically — no one has
            to remember to log anything. Pair with the iPropy Companion app on the phone; the
            one-time token goes into its "Pair this device" screen.
          </p>
        </div>
        <button className="btn-primary btn-sm shrink-0" onClick={() => setPairOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Pair a phone
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (devices ?? []).length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-8 w-8" />}
          title="No phones paired yet"
          body="Pair the first handset and every call it makes or takes will show up in the CRM automatically."
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          {(devices ?? []).map((raw) => {
            const d = raw as {
              id: string; label: string | null; platform: string | null;
              token_preview: string | null; phone_number: string | null; model: string | null;
              app_version: string | null; is_active: boolean; last_sync_at: string | null;
              user_name: string | null; call_count: number; created_at: string;
            };
            return (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    <Smartphone className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-xs font-medium">{d.label ?? 'Android phone'}</p>
                      {!d.is_active && <Badge color="red">Revoked</Badge>}
                    </div>
                    <p className="text-2xs text-muted">
                      {d.model ? `${d.model} · ` : ''}
                      {d.phone_number ? `${d.phone_number} · ` : ''}
                      {d.app_version ? `v${d.app_version} · ` : ''}
                      {d.token_preview ? `•• ${d.token_preview} · ` : ''}
                      {d.user_name && d.user_name !== user?.fullName ? `${d.user_name} · ` : ''}
                      paired {relativeTime(d.created_at)}
                      {d.last_sync_at ? ` · synced ${relativeTime(d.last_sync_at)}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge color="#10b981">{d.call_count} calls logged</Badge>
                  {d.is_active && (
                    <button
                      className="btn-ghost btn-sm text-negative"
                      onClick={() => setRevoking({ id: d.id, label: d.label ?? 'this phone' })}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <PairPhoneModal
        open={pairOpen}
        onClose={() => setPairOpen(false)}
        onPaired={() => void refetch()}
      />

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revokeNow()}
        title="Revoke this phone?"
        confirmLabel="Revoke"
        body="It will stop syncing calls immediately. Pairing again later needs a fresh token from this screen."
        danger
      />
    </div>
    </div>
  );
}

/**
 * Pair flow for a call-logging phone.
 *
 * The pairing token is a bearer credential for the companion app's background
 * sync, so two rules apply: (1) it is shown exactly once on this screen, the
 * server only persists its sha-256 hash, and (2) the modal resets whenever it
 * opens so a copied token is never left lying around for the next person.
 */
function PairPhoneModal({ open, onClose, onPaired }: {
  open: boolean; onClose: () => void; onPaired: () => void;
}): JSX.Element {
  const [form, setForm] = useState({ label: '', phoneNumber: '', model: '' });
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<{ token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ label: '', phoneNumber: '', model: '' });
    setPairing(null);
    setCopied(false);
    setBusy(false);
  }, [open]);

  const pair = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.pairDevice({
        label: form.label.trim() || undefined,
        phoneNumber: form.phoneNumber.trim() || null,
        model: form.model.trim() || null,
      });
      setPairing({ token: res.token });
      onPaired();
    } catch (err) {
      toast.error('Could not pair phone', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyToken = (): void => {
    if (!pairing) return;
    void navigator.clipboard.writeText(pairing.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={pairing ? 'Pairing complete' : 'Pair a phone'}
      size="sm"
      footer={
        pairing ? (
          <button className="btn-primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={() => void pair()} disabled={busy}>
              {busy ? <Spinner /> : <Plus className="h-4 w-4" />} Pair device
            </button>
          </>
        )
      }
    >
      {pairing ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Copy this token into the app now — it is not shown again. It grants the phone access
            to your call data, so treat it like a password.
          </p>
          <div className="relative rounded-lg border border-slate-200 bg-slate-50 p-3 pr-10 dark:border-slate-700 dark:bg-slate-950/60">
            <code className="block break-all font-mono text-xs">{pairing.token}</code>
            <button
              className="btn-ghost btn-sm absolute right-1.5 top-1.5"
              onClick={copyToken}
              aria-label="Copy the pairing token"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <p className="text-2xs text-muted">
            In <span className="font-medium">iPropy Companion</span> on the phone: tap Pair this
            device, then paste this token.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="e.g. Rishabh's main phone"
              autoFocus
            />
          </div>
          <div>
            <label className="label">Phone number</label>
            <input
              className="input tnum"
              value={form.phoneNumber}
              onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
              placeholder="+91 98xxx xxxxx"
            />
            <p className="mt-1 text-2xs text-muted">
              Used to match calls to the right lead on the last ten digits.
            </p>
          </div>
          <div>
            <label className="label">Model</label>
            <input
              className="input"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="e.g. OnePlus 12R"
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
