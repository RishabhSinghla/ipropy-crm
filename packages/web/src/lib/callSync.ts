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
import { toast } from './store';
import { apiBase, isAndroid, isNative } from './native';

export interface CallSyncStatus {
  available: boolean;
  paired: boolean;
  callLogGranted: boolean;
  callPhoneGranted: boolean;
  locationGranted: boolean;
  backgroundLocationGranted: boolean;
  /** Epoch millis, 0 when it has never run. */
  lastSyncAt: number;
  lastSyncSummary: string | null;
  locationEnabled: boolean;
  uploadRecordings: boolean;
  /** Whether the rep has pointed the app at their phone recorder's folder. Absent on an older build. */
  recordingFolderChosen?: boolean;
  version: string;
  /**
   * Whether this handset may end a call on the CRM's instruction.
   *
   * Absent on an older build, which is why it is optional rather than false:
   * `undefined` means "this app is too old to say", and the checklist draws
   * it as not done either way.
   */
  canEndCall?: boolean;
  /**
   * Whether iPropy is this phone's calling app — the only way Android lets an
   * app switch speaker, mute and hold on a running call, or know when the
   * other side picked up. Absent on an older build.
   */
  canControlCall?: boolean;
}

interface CallSyncPlugin {
  status(): Promise<CallSyncStatus>;
  pair(options: { baseUrl: string; token: string; importHistory: boolean }): Promise<CallSyncStatus>;
  unpair(): Promise<CallSyncStatus>;
  syncNow(): Promise<{ started: boolean }>;
  setLocationEnabled(options: { enabled: boolean }): Promise<CallSyncStatus>;
  setUploadRecordings(options: { enabled: boolean }): Promise<CallSyncStatus>;
  /** Android's folder chooser, for the folder the phone's call recorder saves to. */
  chooseRecordingFolder(): Promise<CallSyncStatus>;
  requestCallLog(): Promise<CallSyncStatus>;
  requestCallPermissions(): Promise<CallSyncStatus>;
  placeCall(options: { number: string; commandId?: string }): Promise<{ placed: boolean; reason?: string }>;
  /** Ends the call this handset is on. Only the phone's own dialler may. */
  endCall(options: { commandId?: string }): Promise<{ ended: boolean; reason?: string }>;
  /** Whether Android has this app as the default phone app, right now. */
  callControl(): Promise<{ canEndCall: boolean; canControlCall?: boolean }>;
  /** Android's own "make iPropy your calling app" dialog. */
  requestCallApp(): Promise<{ canControlCall: boolean }>;
  /** Android's default-apps settings, to hand the calling app back. */
  openCallAppSettings(): Promise<void>;
  /** Speaker, mute, hold or end, on the call this phone is on. */
  callAction(options: { action: string; on: boolean; commandId?: string }): Promise<{ done: boolean; reason?: string }>;
  /** Ask for the permission that lets the CRM end a call. Android's own dialog. */
  requestDialerRole(): Promise<{ canEndCall: boolean }>;
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
  callPhoneGranted: false,
  locationGranted: false,
  backgroundLocationGranted: false,
  lastSyncAt: 0,
  lastSyncSummary: null,
  locationEnabled: false,
  uploadRecordings: false,
  version: '',
  canEndCall: false,
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

  const granted = await CallSync.requestCallPermissions();
  if (!granted.callLogGranted || !granted.callPhoneGranted) return granted;

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

/**
 * Ask Android for the two call permissions, on their own.
 *
 * `enableCallSync` asks for them as part of pairing, which is right the first
 * time and wrong every time after: a rep who tapped Deny once, or who revoked
 * a permission later, is already paired and has nothing left to press. This is
 * that button. Android only shows a dialog while it is willing to — after two
 * refusals it answers "denied" without one, which is what `openAppSettings`
 * exists for.
 */
export async function askForCallPermissions(): Promise<CallSyncStatus> {
  if (!callSyncSupported) return UNAVAILABLE;
  return CallSync.requestCallPermissions();
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

/**
 * Ring a number from this handset, on the CRM's instruction.
 *
 * The rep pressed Call at a desk; this is the phone in their pocket doing as
 * it was told. It leaves through the dialler with the number already dialling,
 * so there is no app chooser and nothing to tap — the permission for that was
 * granted once, when they paired.
 *
 * Answers rather than throws when it cannot: an old build with no `placeCall`
 * in it, a permission the rep later revoked, or a handset with no SIM. The
 * caller reports the call as not placed, which is the truth and is actionable,
 * instead of the CRM claiming a call that never rang.
 */
export async function placeCallFromPhone(
  number: string, commandId?: string,
): Promise<{ placed: boolean; reason?: string }> {
  if (!callSyncSupported) return { placed: false, reason: 'not-a-phone' };
  try {
    // The command id travels into the native side rather than being closed
    // from here: the result has to be posted with the *device* token, which
    // only the plugin holds. A session token cannot speak for a handset.
    return await CallSync.placeCall({ number, commandId });
  } catch (err) {
    return { placed: false, reason: (err as Error).message || 'failed' };
  }
}

/**
 * End the call this handset is on.
 *
 * Only Android's **default phone app** may, so an older build — or one the rep
 * has not made their dialler — answers `ended: false` with a reason rather
 * than throwing. The CRM then says so instead of claiming a call was cut off
 * while the two people are still talking.
 */
export async function endCallOnPhone(commandId?: string): Promise<{ ended: boolean; reason?: string }> {
  if (!callSyncSupported) return { ended: false, reason: 'not-a-phone' };
  try {
    return await CallSync.endCall({ commandId });
  } catch (err) {
    return { ended: false, reason: (err as Error).message || 'failed' };
  }
}

/** Whether this handset can end, and control, a call today. Answers false on an old build. */
export async function callControlState(): Promise<{ canEndCall: boolean; canControlCall: boolean }> {
  if (!callSyncSupported) return { canEndCall: false, canControlCall: false };
  try {
    const answer = await CallSync.callControl();
    return { canEndCall: answer.canEndCall, canControlCall: answer.canControlCall === true };
  } catch {
    return { canEndCall: false, canControlCall: false };
  }
}

/**
 * Ask Android to make iPropy this phone's calling app.
 *
 * What it buys: the CRM can switch speaker, mute and hold on a live call and
 * knows the moment the other side picks up, and the phone's own call screen
 * becomes iPropy's. The rep can hand it back from Android's settings.
 */
export async function askToControlCalls(): Promise<{ canControlCall: boolean }> {
  if (!callSyncSupported) return { canControlCall: false };
  try {
    return await CallSync.requestCallApp();
  } catch (err) {
    toast.error('This app is too old to control calls', 'Install the newest iPropy app, then try again.');
    return { canControlCall: false };
  }
}

/** Carry out a live-call instruction from the desk, on the call this phone is on. */
export async function performCallAction(action: string, on: boolean, commandId: string): Promise<{ done: boolean; reason?: string }> {
  if (!callSyncSupported) return { done: false, reason: 'not-android' };
  try {
    return await CallSync.callAction({ action, on, commandId });
  } catch (err) {
    return { done: false, reason: (err as Error).message || 'this app is too old to control calls' };
  }
}

/**
 * Ask for the permission that lets the CRM end a call on this handset.
 *
 * Not the default-dialler role, which is what "hang up from the computer"
 * looked like it would cost: `TelecomManager.endCall()` needs
 * `ANSWER_PHONE_CALLS` and nothing else, so the rep keeps the phone app they
 * already use and everything else about their phone is unchanged.
 */
export async function askToEndCalls(): Promise<{ canEndCall: boolean }> {
  if (!callSyncSupported) return { canEndCall: false };
  try {
    return await CallSync.requestDialerRole();
  } catch (err) {
    toast.error('Android would not ask', (err as Error).message);
    return { canEndCall: false };
  }
}

/**
 * Point the app at the phone's call-recorder folder, which is what lets
 * recordings reach the CRM at all. Android shows its own folder chooser.
 */
export async function chooseRecordingFolder(): Promise<CallSyncStatus> {
  if (!callSyncSupported) return UNAVAILABLE;
  try {
    return await CallSync.chooseRecordingFolder();
  } catch {
    toast.error('This app is too old to send recordings', 'Install the newest iPropy app, then try again.');
    return await callSyncStatus();
  }
}
