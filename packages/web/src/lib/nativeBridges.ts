/**
 * The behaviours an installed app has to get right and a web page never has to
 * think about: the hardware back button, links opened from outside, losing the
 * network mid-tap, and coming back to life after an hour in a pocket.
 *
 * Every one of these is a no-op in a browser, which is why they live together
 * behind a single `startNativeBridges()` call rather than being sprinkled
 * through the components they affect.
 */
import { useApp } from './store';
import { isAndroid, isNative } from './native';
import { refreshNativePermission } from './push';

let started = false;

export async function startNativeBridges(): Promise<void> {
  if (!isNative || started) return;
  started = true;

  await Promise.all([
    backButton(), deepLinks(), connectivity(), resume(), keyboard(), notifications(),
  ]);
  await hideSplash();
}

// ---------------------------------------------------------------------------

async function backButton(): Promise<void> {
  if (!isAndroid) return;
  const { App } = await import('@capacitor/app');

  /*
    Android's back button is not a browser back button, and treating it as one
    is the single most common way an app feels broken. Two rules the platform
    expects and users will notice the absence of:

    - Back from a nested screen goes up, never out.
    - Back from the home screen leaves the app. It does not sit there doing
      nothing, and it does not log anybody out.

    `canGoBack` comes from the webview's own history, which react-router keeps
    in step, so this stays correct without knowing a single route.
  */
  await App.addListener('backButton', ({ canGoBack }) => {
    // A dialog is the one thing that must swallow back before history does:
    // backing out of a half-filled record and losing it is not recoverable.
    const dismissed = document.dispatchEvent(
      new CustomEvent('ipropy:back', { cancelable: true }),
    ) === false;
    if (dismissed) return;

    if (canGoBack && window.location.pathname !== '/dashboard') window.history.back();
    else void App.exitApp();
  });
}

async function deepLinks(): Promise<void> {
  const { App } = await import('@capacitor/app');

  /*
    A link to a record — from a WhatsApp message, a notification, an email —
    arrives as the full https URL the website would have used. The app has to
    strip the origin and hand the rest to the router, or the OS opens a browser
    on top of the app and the person ends up signed out, looking at a login
    screen for a CRM they have installed.
  */
  await App.addListener('appUrlOpen', ({ url }) => {
    try {
      const parsed = new URL(url);
      const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      if (path && path !== '/') window.history.pushState({}, '', path);
      // The router listens to popstate, not pushState, so tell it by hand.
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch { /* a malformed link is not worth crashing over */ }
  });
}

async function connectivity(): Promise<void> {
  const { Network } = await import('@capacitor/network');

  /*
    `navigator.onLine` inside a webview is close to useless — it reports the
    webview's idea of connectivity, which on Android stays `true` on a wifi
    network with no route to anywhere. The OS knows better, and a rep standing
    in a basement flat needs the offline banner to be honest, because the app
    behaves differently behind it.
  */
  const apply = (connected: boolean): void => {
    const { user, offline } = useApp.getState();
    if (offline === !connected) return;
    useApp.setState({ offline: !connected });
    // Coming back from offline, re-ask who we are: the session may have been
    // refreshed on another device, or expired while the phone had no signal.
    if (connected && user) void useApp.getState().bootstrap();
  };

  const status = await Network.getStatus();
  apply(status.connected);
  await Network.addListener('networkStatusChange', (s) => apply(s.connected));
}

async function resume(): Promise<void> {
  const { App } = await import('@capacitor/app');

  /*
    An app is not reloaded when it comes back to the foreground — it resumes,
    with every number on screen exactly as stale as the moment it was
    backgrounded. A rep who checked a lead before lunch and reopens it after
    must not be reading the morning's figures.

    `refetchOnWindowFocus` is off for this app (see main.tsx), and a webview's
    focus events are unreliable when the OS, rather than the user, moved the
    window — so this is the event that does the job.
  */
  await App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    const { user } = useApp.getState();
    if (user) void useApp.getState().bootstrap();
    window.dispatchEvent(new Event('ipropy:resumed'));
  });
}

async function notifications(): Promise<void> {
  const { PushNotifications } = await import('@capacitor/push-notifications');

  // What the Settings screen shows. Asked, never requested — a permission
  // dialog on first launch, before anybody knows what the app is, is the
  // fastest way to have it refused permanently.
  void refreshNativePermission();

  /*
    The channel the server addresses its notifications to, created here because
    Android will not create one for you.

    From Android 8 a notification naming a channel that does not exist is
    dropped entirely — not shown quietly, not shown without sound: dropped,
    with nothing logged on the handset and a `sent` from Firebase. `sendFcm`
    names `ipropy-alerts`, so this line is what stands between the server
    reporting success and a rep never being told anything.

    Creating it twice is a no-op, so this runs on every launch rather than
    being tracked as a thing already done.
  */
  if (isAndroid) {
    await PushNotifications.createChannel({
      id: 'ipropy-alerts',
      name: 'Leads and reminders',
      description: 'Follow-ups, new leads assigned to you, and anything needing your attention.',
      importance: 4, // heads-up, which a follow-up going cold warrants
      visibility: 1, // shown on the lock screen: this is work, not a secret
      vibration: true,
    }).catch(() => undefined);
  }

  /*
    Tapping a notification.

    This is the whole point of a notification and the part most often left out:
    the alert says "Priya asked for a call back" and tapping it lands on the
    dashboard, leaving the rep to go and find Priya. `data.link` is the record
    path the server put on it — see `sendFcm`.
  */
  await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const link = action.notification.data?.link as string | undefined;
    if (!link || !link.startsWith('/')) return;
    window.history.pushState({}, '', link);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  /*
    Arriving while the app is open.

    Android does not draw a notification for an app in the foreground, so
    without this the alert is simply lost for anybody who happens to be looking
    at the CRM at the time. The bell and the toast already exist and come over
    the socket — this only makes sure the counter is refreshed rather than
    waiting for the next poll.
  */
  await PushNotifications.addListener('pushNotificationReceived', () => {
    window.dispatchEvent(new Event('ipropy:notification'));
  });
}

async function keyboard(): Promise<void> {
  try {
    const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard');
    /*
      `Native` resizes the webview itself rather than pushing the whole page up.
      With the default, opening the keyboard on a long record form scrolls the
      header off and leaves the field being typed into under the keyboard —
      which is most of the reason phone forms get abandoned.
    */
    await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
    await Keyboard.setScroll({ isDisabled: false });
  } catch { /* iOS-only settings on Android, and vice versa */ }
}

async function hideSplash(): Promise<void> {
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    // After the first render, not before: hiding on boot shows a white
    // rectangle for as long as React takes to paint.
    await SplashScreen.hide();
  } catch { /* no splash to hide */ }
}
