/**
 * A read-only copy of what you were last shown, for when there is no signal.
 *
 * The service worker deliberately refuses to cache `/api/*`, and its reasoning
 * is sound as far as it goes: serving a lead stage that changed an hour ago,
 * indistinguishably from a fresh one, is worse than serving nothing.
 *
 * But that argument is about *status*, and it has been applied to everything. A
 * name does not go stale. Neither does a phone number, a budget, or "wants 3
 * BHK in Powai". Standing in the basement of a half-built floor with a buyer
 * asking a question, an hour-old copy of their requirement is infinitely better
 * than a spinner — and refusing to keep one is not caution, it is the CRM being
 * useless exactly where the work happens.
 *
 * So this keeps the original rule and fixes the conclusion:
 *
 *   **Never silently.** Anything served from here is labelled with the time it
 *   was fetched. The app knows it is offline and says so; nothing is passed off
 *   as current.
 *
 *   **Never in the service worker.** A worker-level cache is invisible to the
 *   app and survives a logout, so the next person to sign in on that phone
 *   could be handed the last person's pipeline. This lives in the app layer,
 *   keyed by user id, and is emptied when a session ends.
 *
 *   **Never written back.** Read only. Editing offline would need conflict
 *   resolution, and getting that wrong loses work — which is a worse failure
 *   than not offering it. Site capture already has a proper queue for the one
 *   thing that genuinely must survive no signal.
 */

const DB_NAME = 'ipropy-offline';
const DB_VERSION = 1;
const STORE = 'snapshots';

export interface Snapshot<T = unknown> {
  /** `${userId}:${key}` — the user id is part of the key, not a field to check. */
  id: string;
  data: T;
  fetchedAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Everything here is best-effort.
 *
 * IndexedDB is unavailable in a Safari private window and can throw on a full
 * disk. A CRM that fails to render because its *offline convenience copy*
 * could not be written would be a worse product than one without the feature,
 * so every path swallows and carries on.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

function scopedKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

/** Keep a copy of something the user just saw. */
export async function remember<T>(userId: string, key: string, data: T): Promise<void> {
  if (!userId) return;
  await withStore('readwrite', (store) => store.put({
    id: scopedKey(userId, key), data, fetchedAt: new Date().toISOString(),
  } satisfies Snapshot<T>));
}

/** What was last seen, and when — or null if this device has never held it. */
export async function recall<T>(userId: string, key: string): Promise<Snapshot<T> | null> {
  if (!userId) return null;
  return withStore<Snapshot<T>>('readonly', (store) => store.get(scopedKey(userId, key)));
}

/**
 * Empty it.
 *
 * Called on sign-out. A shared phone is normal in this business — one handset
 * on a desk, whoever is in the office uses it — so "the last person's leads"
 * is a real thing to leave behind, not a hypothetical.
 */
export async function forgetAll(): Promise<void> {
  await withStore('readwrite', (store) => store.clear());
}

/** Is the browser telling us there is no connection? */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * "as of 3:40 pm" — how a person says it.
 *
 * The exact time rather than "2 hours ago", because the question being asked is
 * "can I trust this number", and an absolute time answers it without arithmetic.
 */
export function asOf(fetchedAt: string): string {
  const when = new Date(fetchedAt);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' });
}
