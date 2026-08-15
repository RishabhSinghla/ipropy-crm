import type { JSX } from 'react';
/**
 * Ask once, rather than hoping somebody remembers.
 *
 * Everything the CRM raises — a new enquiry, a buyer who matches stock that
 * just landed, a call waiting to be filed — is written to a row *and* pushed to
 * a device. With no device subscribed the push half lands nowhere, and the
 * whole thing quietly degrades into a bell icon somebody has to think to check.
 * That is the state every deployment starts in, and "tell everyone to turn on
 * alerts" is a step that does not happen if it depends on being told.
 *
 * So the app asks, once, and then never again unless the person says yes.
 *
 * **Deliberately not a modal.** A blocking dialog on first login is the pattern
 * everybody has learned to dismiss without reading, and dismissing it is the
 * outcome we are trying to avoid. This is a strip at the top of the shell that
 * can be ignored for as long as somebody likes and closed for good in one tap.
 *
 * **On iPhone it explains rather than fails.** Apple only exposes push to a
 * site that has been added to the Home Screen, so the button would simply not
 * work in Safari — the one platform this team is entirely on. That case gets
 * the instructions instead of a button that does nothing.
 */
import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { toast } from '../lib/store';
import { currentSubscription, enablePush, permissionState, pushSupport } from '../lib/push';
import { Spinner } from './ui';

/** Per browser, not per account: the subscription being asked about is this device's. */
const DISMISSED_KEY = 'ipropy.alerts-prompt-dismissed';

type Stance = 'hidden' | 'offer' | 'ios-install';

export default function AlertsPrompt(): JSX.Element | null {
  const [stance, setStance] = useState<Stance>('hidden');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (localStorage.getItem(DISMISSED_KEY) === 'yes') return;

      // Already subscribed on this device, or previously refused at the browser
      // level — either way the CRM has nothing useful to add. A person who
      // pressed Block is not persuaded by a strip of HTML.
      if (permissionState() === 'denied') return;
      if (await currentSubscription()) return;

      const support = pushSupport();
      if (cancelled) return;
      if (support.supported) setStance('offer');
      else if (support.reason === 'ios-needs-install') setStance('ios-install');
    })();

    return () => { cancelled = true; };
  }, []);

  const dismiss = (): void => {
    localStorage.setItem(DISMISSED_KEY, 'yes');
    setStance('hidden');
  };

  const turnOn = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await enablePush();
      if (result.ok) {
        toast.success('Alerts on', 'New enquiries will reach this device.');
        dismiss();
      } else {
        toast.error('Could not turn alerts on', result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (stance === 'hidden') return null;

  return (
    <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {stance === 'offer' ? (
        <>
          <span className="min-w-0 flex-1">
            Alerts are off on this device, so a new enquiry will wait until you open the CRM.
          </span>
          <button className="btn-primary btn-sm shrink-0" disabled={busy} onClick={() => void turnOn()}>
            {busy ? <Spinner className="h-3 w-3" /> : null} Turn on alerts
          </button>
        </>
      ) : (
        <span className="min-w-0 flex-1">
          To get alerts on this iPhone, tap <strong>Share</strong> → <strong>Add to Home Screen</strong>,
          then open iPropy from the new icon. Apple does not allow alerts from Safari itself.
        </span>
      )}
      <button
        className="btn-ghost shrink-0 p-1"
        aria-label="Dismiss this reminder"
        onClick={dismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
