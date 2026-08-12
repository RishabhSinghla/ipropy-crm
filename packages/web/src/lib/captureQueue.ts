/**
 * The offline queue behind the site-capture screen.
 *
 * Greenfield sites routinely have no usable signal, and a visit that failed
 * because of that is a visit whose photos are unattributable later — which is
 * the entire problem this feature exists to remove. So the screen never waits
 * for the network: the tap writes to IndexedDB, returns immediately, and the
 * queue drains whenever there is a connection.
 *
 * Not the Background Sync API, deliberately. It is the textbook answer and
 * Safari does not implement it, so on the one device this is actually for it
 * would never fire. Draining happens on `online`, on tab focus, and on a timer
 * while the app is open — all of which work on an iPhone.
 *
 * Safe to drain twice. Every item carries a `clientRef` minted here before it
 * is stored, and the server treats a repeat as the same visit (200 + replayed)
 * rather than a second one. That matters because the failure this is most
 * likely to hit is a request that actually succeeded but whose response was
 * lost — which is indistinguishable, from here, from one that never landed.
 */
import { api } from './api';

const DB_NAME = 'ipropy-capture';
const DB_VERSION = 1;
const STORE = 'pending';

/**
 * A visit waiting to be sent, and optionally the note recorded with it.
 *
 * The audio rides along as a Blob — IndexedDB stores those natively, so a
 * twenty-second recording survives the phone being locked, the app being
 * killed, and the drive home with no signal.
 *
 * It cannot be sent with the visit: the upload endpoint needs a session id,
 * which only exists once the visit has landed. So a queued item becomes a
 * `voice` item after its visit syncs, and that second stage is queued in its
 * own right rather than being a fire-and-forget the user never hears about.
 */
export interface QueuedVisit {
  kind?: 'visit';
  clientRef: string;
  body: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  /** Shown in the list while it waits, so a queued visit is never invisible. */
  label: string;
  audio?: Blob;
  audioName?: string;
}

/** The second stage: audio whose visit has already reached the server. */
export interface QueuedVoice {
  kind: 'voice';
  clientRef: string;
  sessionId: string;
  audio: Blob;
  audioName: string;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  label: string;
}

/** An explicit Finish tap, queued behind the visit it closes. */
export interface QueuedFinish {
  kind: 'finish';
  clientRef: string;
  visitClientRef: string;
  endedAt: string;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  label: string;
}

export type QueuedItem = QueuedVisit | QueuedVoice | QueuedFinish;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'clientRef' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const req = fn(transaction.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const listQueued = (): Promise<QueuedItem[]> =>
  tx<QueuedItem[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedItem[]>)
    // Oldest first: visits close each other, so replaying them out of order
    // would hand the wrong window to the wrong property.
    .then((rows) => rows.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)));

const put = (item: QueuedItem): Promise<IDBValidKey> => tx('readwrite', (s) => s.put(item));
const remove = (clientRef: string): Promise<undefined> => tx('readwrite', (s) => s.delete(clientRef));

/** Subscribers are the screen's pending badge; fired after every change. */
type Listener = () => void;
const listeners = new Set<Listener>();
export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (): void => { listeners.forEach((fn) => { fn(); }); };

/**
 * Record a visit. Always succeeds — that is the point.
 *
 * The caller gets control back as soon as it is on disk, so the screen can say
 * "saved" while somebody is already walking into the property. Whether it
 * reached the server is a separate, later question.
 */
export async function enqueueVisit(
  clientRef: string,
  body: Record<string, unknown>,
  label: string,
  audio?: { blob: Blob; name: string },
): Promise<void> {
  await put({
    kind: 'visit', clientRef, body, label, queuedAt: new Date().toISOString(), attempts: 0,
    ...(audio ? { audio: audio.blob, audioName: audio.name } : {}),
  });
  emit();
  void flushQueue();
}

/**
 * Finish is written locally first for the same reason Start is. Its queue key
 * differs from the visit's idempotency key so both records can coexist in the
 * one IndexedDB store; the API still receives the original ref.
 */
export async function enqueueFinish(visitClientRef: string, label: string, endedAt: string): Promise<void> {
  await put({
    kind: 'finish',
    clientRef: `${visitClientRef}:finish`,
    visitClientRef,
    endedAt,
    label,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  });
  emit();
  void flushQueue();
}

let flushing = false;

export interface FlushResult { sent: number; failed: number; remaining: number }

/**
 * Push what is queued, oldest first, stopping at the first transient failure.
 *
 * Stopping rather than skipping is deliberate. Visits close each other, so
 * sending visit 3 while visit 2 is still stuck would close a visit that has not
 * happened yet from the server's point of view, and photos would land against
 * the wrong property. Order is worth more here than throughput.
 *
 * Repeated in passes because sending a visit can *create* work: a visit
 * carrying audio mints a second-stage `voice` item once it has a session id,
 * and a single sweep over a snapshot taken at the start would leave that
 * sitting until the next tick a minute later. The pass count is bounded so a
 * bug that endlessly re-queues cannot spin here.
 */
const MAX_PASSES = 5;

export async function flushQueue(): Promise<FlushResult> {
  if (flushing || !navigator.onLine) {
    return { sent: 0, failed: 0, remaining: (await listQueued()).length };
  }
  flushing = true;
  let sent = 0;
  let failed = 0;
  try {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const items = await listQueued();
      if (!items.length) break;

      let progressed = false;
      let stalled = false;

      for (const item of items) {
        try {
          if (item.kind === 'voice') {
            await api.uploadCaptureVoice(item.sessionId, item.audio, item.audioName);
          } else if (item.kind === 'finish') {
            await api.finishCapture({ clientRef: item.visitClientRef, endedAt: item.endedAt });
          } else {
            const { session } = await api.startCapture(item.body);
            // The visit has landed; hand its audio to a second-stage item rather
            // than uploading inline. If the connection dies between the two, the
            // visit is safe and the recording is still queued rather than lost.
            if (item.audio) {
              await put({
                kind: 'voice',
                clientRef: `${item.clientRef}:voice`,
                sessionId: session.id,
                audio: item.audio,
                audioName: item.audioName ?? 'note.m4a',
                label: item.label,
                queuedAt: new Date().toISOString(),
                attempts: 0,
              });
            }
          }
          await remove(item.clientRef);
          sent += 1;
          progressed = true;
          emit();
        } catch (err) {
          // A 4xx will never succeed on retry — a malformed body, or a property
          // the user has since lost access to. Keeping it would block every later
          // visit behind something that can only fail, so it is recorded on the
          // item and the queue moves past it.
          const status = (err as { status?: number }).status;
          const permanent = typeof status === 'number' && status >= 400 && status < 500;
          await put({
            ...item,
            attempts: item.attempts + 1,
            lastError: (err as Error).message,
          });
          failed += 1;
          emit();
          if (!permanent) { stalled = true; break; }
        }
      }

      // Nothing moved, or the network went away mid-pass: another identical
      // pass would only repeat the same failure immediately.
      if (!progressed || stalled) break;
    }
  } finally {
    flushing = false;
  }
  return { sent, failed, remaining: (await listQueued()).length };
}

/** Give up on an item the user has decided is not worth keeping. */
export async function discardQueued(clientRef: string): Promise<void> {
  await remove(clientRef);
  emit();
}

let started = false;

/**
 * Drain on the events an iPhone actually delivers.
 *
 * `visibilitychange` is the important one: the phone goes in a pocket at the
 * gate and comes out in the car with signal, which fires no `online` event
 * because the connection never technically dropped from the browser's point of
 * view — but the request that failed at the gate is still sitting here.
 */
export function startCaptureSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => { void flushQueue(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushQueue();
  });
  window.setInterval(() => { void flushQueue(); }, 60_000);
  void flushQueue();
}
