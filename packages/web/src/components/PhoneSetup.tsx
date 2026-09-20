/**
 * Everything this phone has to allow before a desk Call can ring it — asked
 * for one step at a time, with the reason in front of each one.
 *
 * **20 September 2026, the owner:** *"if APK need any permission please ask
 * before install app, make the working structure."*
 *
 * Android grants an app nothing at install time; every permission is asked for
 * later, by the code that needs it. So an APK can be installed, signed into and
 * look perfectly healthy while being unable to ring anybody — which is what
 * production has been doing: 130 dial instructions queued, not one collected.
 * Nothing on the phone said which permission was missing, because nothing on
 * the phone was looking.
 *
 * This screen is that missing half. It lives in the **web** bundle on purpose,
 * which is the half that updates itself from production — so it reaches every
 * installed handset without an APK rebuild, and this container has no Android
 * SDK to make one with.
 *
 * Two things it deliberately does not do. It never claims a permission Android
 * has not actually granted: every row is redrawn from the plugin's own answer
 * after each tap. And it never asks for location unless somebody switched
 * location on — a permission offered to a rep who never asked for it reads as
 * the CRM wanting to follow them home.
 */
import { type JSX, useCallback, useEffect, useState } from 'react';
import { Check, ChevronRight, Settings as SettingsIcon, ShieldAlert } from 'lucide-react';
import { toast } from '../lib/store';
import {
  askForCallPermissions, callSyncStatus, callSyncSupported, enableCallSync,
  openAppSettings, setCallSyncLocation, type CallSyncStatus,
} from '../lib/callSync';
import { enablePush, permissionState } from '../lib/push';
import { blockingSteps, phoneChecklist, type PhoneStep } from '../lib/phonePermissions';
import { Spinner } from './ui';

type Alerts = 'granted' | 'denied' | 'default' | 'unavailable';

export function usePhoneSetup(): {
  status: CallSyncStatus | null;
  alerts: Alerts;
  blocking: PhoneStep[];
  refresh: () => void;
} {
  const [status, setStatus] = useState<CallSyncStatus | null>(null);
  const [alerts, setAlerts] = useState<Alerts>('default');

  const refresh = useCallback((): void => {
    void callSyncStatus().then(setStatus);
    setAlerts(permissionState() as Alerts);
  }, []);

  useEffect(refresh, [refresh]);

  return { status, alerts, blocking: blockingSteps({ status, alerts }), refresh };
}

/**
 * The checklist. Renders nothing at all outside the Android app, and nothing
 * when the installed build has no plugin in it — a row of Allow buttons that
 * reject is worse than no screen.
 */
export function PhoneSetup({ compact }: { compact?: boolean } = {}): JSX.Element | null {
  const { status, alerts, refresh } = usePhoneSetup();
  const [busy, setBusy] = useState<PhoneStep | null>(null);

  if (!callSyncSupported || !status?.available) return null;

  const rows = phoneChecklist({ status, alerts });
  const done = rows.filter((r) => r.done).length;

  /*
    Redrawn from the plugin's own answer, never from the fact a button was
    pressed: after two refusals Android stops showing the dialog at all, and a
    tick there would be a lie the rep then acts on.
  */
  const settled = (step: PhoneStep, next: CallSyncStatus): void => {
    refresh();
    if (step === 'pair' && next.paired) {
      toast.success('This phone is connected', 'Calls you make and take now reach the CRM.');
    }
  };

  const allow = async (step: PhoneStep): Promise<void> => {
    setBusy(step);
    try {
      if (step === 'pair') {
        settled(step, await enableCallSync());
      } else if (step === 'callPhone' || step === 'callLog') {
        settled(step, await askForCallPermissions());
      } else if (step === 'alerts') {
        const result = await enablePush();
        if (!result.ok) toast.error('Notifications not turned on', result.message);
        refresh();
      } else {
        /*
          "All the time" is the one Android refuses to grant from a pop-up: the
          dialog can only offer "while using the app". So this asks for what it
          can and then opens the app's own settings page, where the choice
          actually lives, rather than looking as though the tap did nothing.
        */
        const next = await setCallSyncLocation(true);
        settled(step, next);
        if (!next.backgroundLocationGranted) {
          toast.info('One more tap, in Android', 'Open Permissions → Location and choose "Allow all the time".');
          await openAppSettings();
        }
      }
    } catch (err) {
      toast.error('Android would not allow it', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card space-y-3 p-5">
      <div>
        <p className="text-sm font-medium">What this phone needs to allow</p>
        <p className="mt-1 text-sm text-muted">
          Android asks for each of these from inside the app, never when it is installed.
          Until the first three are allowed, pressing Call on a computer cannot ring this
          handset. {done} of {rows.length} done.
        </p>
      </div>

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 dark:border-slate-800"
          >
            <span
              className={
                row.done
                  ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-positive/15 text-positive'
                  : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-muted dark:bg-slate-800'
              }
            >
              {row.done ? <Check className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {row.title}
                {!row.required && <span className="ml-2 text-2xs text-muted">optional</span>}
              </p>
              {!compact && <p className="mt-0.5 text-2xs text-muted">{row.why}</p>}
            </div>

            {row.done ? (
              <span className="shrink-0 self-center text-2xs text-positive">Allowed</span>
            ) : (
              <button
                className="btn-secondary btn-sm shrink-0 self-center"
                disabled={busy !== null}
                onClick={() => void allow(row.key)}
              >
                {busy === row.key ? <Spinner className="h-3.5 w-3.5" /> : null}
                Allow
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
        <p className="text-2xs text-muted">
          Tapped Deny twice? Android stops showing the question and only its own settings page
          can change the answer.
        </p>
        <button className="btn-ghost btn-sm mt-1" onClick={() => void openAppSettings()}>
          <SettingsIcon className="h-3.5 w-3.5" /> Open this app&apos;s Android settings
        </button>
      </div>
    </div>
  );
}
