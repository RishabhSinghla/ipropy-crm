/**
 * Browser push subscription.
 *
 * Works on desktop Chrome/Edge/Firefox and Android Chrome directly. On iOS,
 * Safari only delivers push to a site that has been added to the home screen —
 * so `pushSupport()` reports that case separately, because "your browser
 * doesn't support notifications" would be wrong and unactionable when the fix
 * is one Share-sheet tap away.
 */
import { api } from './api';
import { isNative, platform } from './native';

const NATIVE_ENDPOINT_KEY = 'ipropy.pushEndpoint';

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: 'unsupported' | 'ios-needs-install' | 'insecure' };

export function pushSupport(): PushSupport {
  /*
    The app is always supported and never asks any of the questions below. It
    has no service worker and no PushManager — notifications reach it through
    Firebase on Android and APNs on iPhone, which the OS delivers whether the
    app is open, backgrounded or closed. The iOS advice further down, about
    adding the site to the Home Screen first, would be actively wrong here:
    there is nothing to add, they already installed it.
  */
  if (isNative) return { supported: true };

  // Push requires a secure context. localhost counts as secure, which is what
  // makes it testable in dev.
  if (!window.isSecureContext) return { supported: false, reason: 'insecure' };

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // iOS 16.4+ exposes PushManager only inside an installed (standalone) PWA.
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as { standalone?: boolean }).standalone === true;
    if (isIos && !standalone) return { supported: false, reason: 'ios-needs-install' };
    return { supported: false, reason: 'unsupported' };
  }
  return { supported: true };
}

export function permissionState(): NotificationPermission | 'unavailable' {
  // In the app the OS owns this, and `Notification` does not exist in the
  // webview at all. `nativePermission` is kept in step by `enablePush` and by
  // the check `startNativeBridges` runs at launch.
  if (isNative) return nativePermission;
  if (!('Notification' in window)) return 'unavailable';
  return Notification.permission;
}

/*
  The app's notification permission, mirrored so the Settings screen can read
  it synchronously the way it always has. Asking the OS is asynchronous, and
  making this function async would ripple into every caller for no gain.
*/
let nativePermission: NotificationPermission = 'default';

/*
  The `fcm:<token>` the server files this handset under. Remembered so turning
  notifications off can name the exact row to delete — the alternative is
  deleting by user, which would silence a rep's other devices as well.
*/
let nativeEndpoint: string | null = null;

/** Read the OS's answer without asking for anything. Called at launch. */
export async function refreshNativePermission(): Promise<NotificationPermission> {
  if (!isNative) return permissionState() as NotificationPermission;
  try { nativeEndpoint = localStorage.getItem(NATIVE_ENDPOINT_KEY); } catch { /* ignore */ }
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const { receive } = await PushNotifications.checkPermissions();
  nativePermission = receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'default';
  return nativePermission;
}

/**
 * Turn notifications on for the installed app.
 *
 * Two things have to happen and only one of them is the permission dialog. The
 * second is registration: the OS mints a token for this install, hands it back
 * asynchronously through a listener, and until the CRM has that token it can
 * address nothing. An implementation that resolves after the dialog reports
 * success and delivers no notification ever — so this waits for the token.
 */
async function enableNativePush(): Promise<{ ok: boolean; message: string }> {
  const { PushNotifications } = await import('@capacitor/push-notifications');

  let state = (await PushNotifications.checkPermissions()).receive;
  if (state === 'prompt' || state === 'prompt-with-rationale') {
    state = (await PushNotifications.requestPermissions()).receive;
  }
  nativePermission = state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'default';

  if (state !== 'granted') {
    return {
      ok: false,
      message: 'Notifications are switched off for iPropy. Turn them on in your phone\u2019s Settings, under Apps \u2192 iPropy \u2192 Notifications.',
    };
  }

  const token = await new Promise<string | null>((resolve) => {
    /*
      Ten seconds, then give up with something true to say. Registration goes
      out to Google's or Apple's servers, and on a handset with no Play
      Services — a plain Chinese-market ROM, which does turn up on an Indian
      sales desk — the listener is simply never called. Waiting for ever there
      is a spinner nobody can escape.
    */
    const timer = window.setTimeout(() => { void cleanup(); resolve(null); }, 10_000);
    const handles: { remove: () => Promise<void> }[] = [];
    const cleanup = async (): Promise<void> => {
      window.clearTimeout(timer);
      await Promise.all(handles.map((h) => h.remove().catch(() => undefined)));
    };

    void PushNotifications.addListener('registration', (t) => {
      void cleanup(); resolve(t.value);
    }).then((h) => handles.push(h));

    void PushNotifications.addListener('registrationError', () => {
      void cleanup(); resolve(null);
    }).then((h) => handles.push(h));

    void PushNotifications.register();
  });

  if (!token) {
    return {
      ok: false,
      message: 'This phone could not register for notifications. That usually means Google Play services are missing or out of date.',
    };
  }

  await api.registerAppPush({ token, platform: platform === 'ios' ? 'ios' : 'android' });
  nativeEndpoint = `fcm:${token}`;
  try { localStorage.setItem(NATIVE_ENDPOINT_KEY, nativeEndpoint); } catch { /* ignore */ }
  return { ok: true, message: 'Alerts are on for this phone.' };
}

/**
 * Is this device registered to receive notifications?
 *
 * Callers only ever ask truthiness of the browser's subscription object, so
 * the app answers the same question with the same shape rather than a second
 * function every screen would have to branch on. `nativeEndpoint` is the row
 * the server knows this handset by.
 */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (isNative) {
    return nativeEndpoint
      ? ({ endpoint: nativeEndpoint } as unknown as PushSubscription)
      : null;
  }
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Ask permission, subscribe, and register the subscription with the server.
 * Returns a human-readable failure rather than throwing, because every failure
 * here is something the user has to act on themselves.
 */
export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  if (isNative) return enableNativePush();

  const support = pushSupport();
  if (!support.supported) {
    return {
      ok: false,
      message: support.reason === 'ios-needs-install'
        ? 'On iPhone and iPad, add iPropy to your Home Screen first (Share → Add to Home Screen), then turn alerts on from there.'
        : support.reason === 'insecure'
          ? 'Notifications need a secure connection (https).'
          : 'This browser cannot receive push notifications.',
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      message: permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.'
        : 'Notification permission was dismissed.',
    };
  }

  // `ready` rather than `getRegistration` — on a first visit the worker may
  // still be installing, and subscribing against an unactivated one fails.
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();

  const existing = await reg.pushManager.getSubscription();
  const subscription = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, message: 'The browser returned an incomplete subscription.' };
  }

  await api.pushSubscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return { ok: true, message: 'Alerts are on for this device.' };
}

export async function disablePush(): Promise<void> {
  if (isNative) {
    const endpoint = nativeEndpoint;
    /*
      The OS registration is left alone deliberately. Unregistering from
      Firebase is a device-wide act that a later re-enable cannot always undo
      on the same token, and the CRM only ever sends to rows it holds — so
      deleting the row is both sufficient and reversible.
    */
    nativeEndpoint = null;
    try { localStorage.removeItem(NATIVE_ENDPOINT_KEY); } catch { /* ignore */ }
    if (endpoint) await api.pushUnsubscribe(endpoint).catch(() => undefined);
    return;
  }

  const subscription = await currentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => undefined);
  // Server-side removal last: if unsubscribe() fails the row must stay, or the
  // device keeps receiving pushes nothing can turn off.
  await api.pushUnsubscribe(endpoint).catch(() => undefined);
}

/**
 * VAPID keys travel as base64url; PushManager wants raw bytes. Browsers do not
 * accept the base64url alphabet here, hence the -/_ swap and the padding.
 */
function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalised);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  // Returned as the underlying buffer: lib.dom types applicationServerKey as
  // BufferSource, which a Uint8Array<ArrayBufferLike> no longer satisfies.
  return bytes.buffer as ArrayBuffer;
}
