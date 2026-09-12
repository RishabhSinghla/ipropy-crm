/**
 * The call sync, from the web side.
 *
 * The engine is native and runs whether or not anybody has the CRM open — it
 * is WorkManager waking every fifteen minutes, reading the call log and
 * posting what is new. This file is only the conversation between that engine
 * and the Settings screen.
 *
 * On the web, and on iPhone, `available` is false and every screen that uses
 * this hides itself. iOS has no call-log API at all: Apple does not expose one
 * to any app, at any permission level, so this is not a gap to fill later —
 * there is nothing to fill it with, and saying "coming soon" on an iPhone
 * would be a promise nobody can keep.
 */
import { registerPlugin } from '@capacitor/core';
import { api } from './api';
import { apiBase, isAndroid, isNative } from './native';

export interface CallSyncStatus {
  available: boolean;
  paired: boolean;
  callLogGranted: boolean;
  locationGranted: boolean;
  backgroundLocationGranted: boolean;
  /** Epoch millis, 0 when it has never run. */
  lastSyncAt: number;
  lastSyncSummary: string | null;
  locationEnabled: boolean;
  uploadRecordings: boolean;
  version: string;
}

interface CallSyncPlugin {
  status(): Promise<CallSyncStatus>;
  pair(options: { baseUrl: string; token: string; importHistory: boolean }): Promise<CallSyncStatus>;
  unpair(): Promise<CallSyncStatus>;
  syncNow(): Promise<{ started: boolean }>;
  setLocationEnabled(options: { enabled: boolean }): Promise<CallSyncStatus>;
  setUploadRecordings(options: { enabled: boolean }): Promise<CallSyncStatus>;
  requestCallLog(): Promise<CallSyncStatus>;
  requestLocation(): Promise<CallSyncStatus>;
  openAppSettings(): Promise<void>;
}

const CallSync = registerPlugin<CallSyncPlugin>('CallSync');

/** Only an Android build has the engine. Everything else answers honestly. */
export const callSyncSupported = isNative && isAndroid;

const UNAVAILABLE: CallSyncStatus = {
  available: false,
  paired: false,
  callLogGranted: false,
  locationGranted: false,
  backgroundLocationGranted: false,
  lastSyncAt: 0,
  lastSyncSummary: null,
  locationEnabled: false,
  uploadRecordings: false,
  version: '',
};

export async function callSyncStatus(): Promise<CallSyncStatus> {
  if (!callSyncSupported) return UNAVAILABLE;
  try {
    return await CallSync.status();
  } catch {
    // An older build of the app with no plugin in it. Reporting unavailable is
    // right: the screen hides rather than offering a button that rejects.
    return UNAVAILABLE;
  }
}

/**
 * Turn call logging on for the phone this is running on.
 *
 * Three steps that used to be a rep's problem and are now one tap:
 *
 * 1. Ask for the call log. Refusing stops here and costs nothing else.
 * 2. Mint a device token. The person is already signed in — this is their own
 *    session asking for a token for their own handset, which is why there is
 *    nothing to type and nothing to send out of band.
 * 3. Hand it to the engine and start the fifteen-minute schedule.
 *
 * `importHistory` can only ever be decided once, before the first sync, and
 * defaults off: on it uploads whatever call history the handset still holds,
 * which on a two-year-old phone is thousands of calls including every personal
 * one. Off, the CRM fills with calls made from now on.
 */
export async function enableCallSync(options: {
  importHistory?: boolean;
  label?: string;
} = {}): Promise<CallSyncStatus> {
  if (!callSyncSupported) return UNAVAILABLE;

  const granted = await CallSync.requestCallLog();
  if (!granted.callLogGranted) return granted;

  const { Device } = await import('@capacitor/device');
  const info = await Device.getInfo();

  const pairing = await api.pairDevice({
    label: options.label ?? `${info.manufacturer ?? ''} ${info.model ?? 'Android phone'}`.trim(),
    model: info.model ?? null,
  });

  /*
    `apiBase()` and not a constant. The engine dials the server on its own, from
    a background worker with no webview running, so it has to be told where the
    server is — and if this build has been pointed at a different one (a second
    tenant, a laptop under test), the calls must follow the CRM the rep is
    actually signed into rather than production.
  */
  return CallSync.pair({
    baseUrl: apiBase() || window.location.origin,
    token: pairing.token,
    importHistory: options.importHistory ?? false,
  });
}

export async function disableCallSync(): Promise<CallSyncStatus> {
  if (!callSyncSupported) return UNAVAILABLE;
  return CallSync.unpair();
}

export async function syncCallsNow(): Promise<void> {
  if (!callSyncSupported) return;
  await CallSync.syncNow();
}

export async function setCallSyncLocation(enabled: boolean): Promise<CallSyncStatus> {
  if (!callSyncSupported) return UNAVAILABLE;
  if (enabled) {
    const asked = await CallSync.requestLocation();
    if (!asked.locationGranted) return asked;
  }
  return CallSync.setLocationEnabled({ enabled });
}

export async function setCallSyncRecordings(enabled: boolean): Promise<CallSyncStatus> {
  if (!callSyncSupported) return UNAVAILABLE;
  return CallSync.setUploadRecordings({ enabled });
}

/** Android's Settings page for this app — the only place "Allow all the time" lives. */
export async function openAppSettings(): Promise<void> {
  if (!callSyncSupported) return;
  await CallSync.openAppSettings();
}
