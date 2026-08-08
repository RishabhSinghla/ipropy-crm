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

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: 'unsupported' | 'ios-needs-install' | 'insecure' };

export function pushSupport(): PushSupport {
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
  if (!('Notification' in window)) return 'unavailable';
  return Notification.permission;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
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
