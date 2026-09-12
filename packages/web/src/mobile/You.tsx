/**
 * The last tab: who you are, and the handful of switches worth having on a
 * phone.
 *
 * A list of rows, the way the phone's own Settings app is. The web version is
 * a modal with six scrolling tabs inside it, which works with a mouse and is
 * unusable with a thumb.
 *
 * Things that genuinely belong at a desk — the admin panel, import, the layout
 * designer — are reachable from the bottom of this list and open the existing
 * screens unchanged. Hiding them would be lying about what the app can do;
 * putting them at the top would be pretending a phone is where they are done.
 */
import { type JSX, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, ChevronRight, LayoutGrid, LogOut, Moon, Phone, Shield, Sun } from 'lucide-react';
import { useApp, toast } from '../lib/store';
import { enablePush, disablePush, currentSubscription, permissionState } from '../lib/push';
import {
  callSyncStatus, callSyncSupported, disableCallSync, enableCallSync, syncCallsNow,
  type CallSyncStatus,
} from '../lib/callSync';
import { Avatar, AppBar, Group, Row } from './primitives';
import { ConfirmDialog, Spinner } from '../components/ui';

export default function MobileYou(): JSX.Element {
  const navigate = useNavigate();
  const { user, theme, setTheme, logout } = useApp();

  const [alerts, setAlerts] = useState<boolean | null>(null);
  const [alertsBusy, setAlertsBusy] = useState(false);
  const [calls, setCalls] = useState<CallSyncStatus | null>(null);
  const [callsBusy, setCallsBusy] = useState(false);
  const [signOut, setSignOut] = useState(false);

  useEffect(() => {
    void currentSubscription().then((s) => setAlerts(Boolean(s) && permissionState() === 'granted'));
    void callSyncStatus().then(setCalls);
  }, []);

  const toggleAlerts = async (): Promise<void> => {
    setAlertsBusy(true);
    try {
      if (alerts) { await disablePush(); setAlerts(false); toast.info('Alerts off for this phone'); }
      else {
        const result = await enablePush();
        setAlerts(result.ok);
        if (result.ok) toast.success(result.message);
        else toast.error('Alerts not turned on', result.message);
      }
    } finally { setAlertsBusy(false); }
  };

  const toggleCalls = async (): Promise<void> => {
    setCallsBusy(true);
    try {
      const next = calls?.paired ? await disableCallSync() : await enableCallSync();
      setCalls(next);
      if (!calls?.paired && !next.callLogGranted) {
        toast.error('Android would not allow it', 'Allow Call logs under Settings → Apps → iPropy → Permissions.');
      }
    } catch (err) {
      toast.error('Could not change it', (err as Error).message);
    } finally { setCallsBusy(false); }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--app-bg)]">
      <AppBar large title="You" />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex items-center gap-4 bg-[var(--surface)] px-4 py-5">
          <Avatar name={user?.fullName ?? '?'} size={60} />
          <div className="min-w-0">
            <p className="truncate text-[19px] font-semibold">{user?.fullName}</p>
            <p className="truncate text-[14px] text-muted">{user?.email}</p>
          </div>
        </div>

        <Group title="This phone">
          <Row
            leading={<Bell className="h-5 w-5 text-slate-500" />}
            title="Alerts"
            subtitle={alerts === null ? 'Checking…' : alerts ? 'On' : 'Off'}
            trailing={alertsBusy ? <Spinner className="h-4 w-4" /> : <Switch on={Boolean(alerts)} />}
            onClick={alertsBusy ? undefined : () => void toggleAlerts()}
          />

          {/*
            Only on Android, and only because only there is there anything to
            switch on. iOS exposes no call-log API to any app at any permission
            level, so an iPhone gets no row rather than a dead switch.
          */}
          {callSyncSupported && calls?.available && (
            <Row
              leading={<Phone className="h-5 w-5 text-slate-500" />}
              title="Log my calls"
              subtitle={
                calls.paired
                  ? (calls.lastSyncAt ? `Last checked ${new Date(calls.lastSyncAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : 'Waiting for the first check')
                  : 'Off'
              }
              trailing={callsBusy ? <Spinner className="h-4 w-4" /> : <Switch on={calls.paired} />}
              onClick={callsBusy ? undefined : () => void toggleCalls()}
            />
          )}

          {calls?.paired && (
            <Row title="Check for new calls now" onClick={() => { void syncCallsNow(); toast.info('Checking now'); }} />
          )}

          <Row
            leading={theme === 'dark' ? <Moon className="h-5 w-5 text-slate-500" /> : <Sun className="h-5 w-5 text-slate-500" />}
            title="Dark mode"
            trailing={<Switch on={theme === 'dark'} />}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          />
        </Group>

        <Group>
          <Row
            leading={<LayoutGrid className="h-5 w-5 text-slate-500" />}
            title="Dashboard"
            subtitle="Numbers for the whole desk"
            trailing={<ChevronRight className="h-5 w-5 text-slate-300" />}
            onClick={() => navigate('/dashboard')}
          />
        </Group>

        {user?.isAdmin && (
          <Group title="Administration" footer="These are built for a desk. They work here, but a laptop is kinder.">
            <Row
              leading={<Shield className="h-5 w-5 text-slate-500" />}
              title="Admin panel"
              trailing={<ChevronRight className="h-5 w-5 text-slate-300" />}
              onClick={() => navigate('/admin')}
            />
          </Group>
        )}

        <Group>
          <Row
            leading={<LogOut className="h-5 w-5 text-rose-600" />}
            title={<span className="text-rose-600">Sign out</span>}
            onClick={() => setSignOut(true)}
          />
        </Group>

        <div style={{ height: 'calc(var(--bottom-nav-h, 0px) + 32px)' }} />
      </div>

      <ConfirmDialog
        open={signOut}
        title="Sign out?"
        body="Anything saved on this phone but not yet sent will be lost."
        confirmLabel="Sign out"
        danger
        onConfirm={() => { setSignOut(false); void logout(); }}
        onClose={() => setSignOut(false)}
      />
    </div>
  );
}

/** Looks like the platform's switch. Not interactive itself — the row is. */
function Switch({ on }: { on: boolean }): JSX.Element {
  return (
    <span
      role="switch"
      aria-checked={on}
      className={`relative inline-block h-[31px] w-[51px] rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
    >
      <span
        className={`absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-[2px]'}`}
      />
    </span>
  );
}
