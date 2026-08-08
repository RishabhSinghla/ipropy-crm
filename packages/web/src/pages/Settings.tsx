import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { Bell, BellOff, Camera, Fingerprint, KeyRound, Monitor, Moon, Save, Sun, User } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { currentSubscription, disablePush, enablePush, permissionState, pushSupport } from '../lib/push';
import { Avatar, Badge, Select, Skeleton, Spinner, Tabs } from '../components/ui';

export default function SettingsPage(): JSX.Element {
  const { user, theme, setTheme } = useApp();
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
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'profile' && <ProfileTab />}
      {tab === 'preferences' && <PreferencesTab theme={theme} setTheme={setTheme} />}
      {tab === 'alerts' && <AlertsTab />}
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
      <PasskeysCard />

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
          This device or browser has no biometric sign-in available. On iPhone and iPad, add
          iPropy to your Home Screen and open it from there first.
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
