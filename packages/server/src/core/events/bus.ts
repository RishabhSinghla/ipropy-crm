/**
 * Tiny typed event bus.
 *
 * The record service emits here; the workflow engine, AI enrichment, webhooks
 * and the realtime socket layer subscribe. Handlers are awaited but never allowed
 * to fail a write — a broken workflow must not roll back a user's save.
 */
import { logger } from '../../utils/logger.js';
import type { AuthUser } from '@ipropy/shared';

export interface RecordEventPayload {
  module: string;
  recordId: string;
  record: Record<string, unknown>;
  previous?: Record<string, unknown>;
  changedFields?: string[];
  user: AuthUser | null;
  source: string;
}

export interface MessageEventPayload {
  conversationId: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
  channel: string;
  body: string | null;
  handle: string;
  recordId: string | null;
}

export interface CallEventPayload {
  callId: string;
  direction: string;
  status: string;
  recordId: string | null;
  userId: string | null;
}

export interface EventMap {
  'record.created': RecordEventPayload;
  'record.updated': RecordEventPayload;
  'record.deleted': RecordEventPayload;
  'record.restored': RecordEventPayload;
  'record.converted': RecordEventPayload & { targets: Record<string, string> };
  'record.owner_changed': RecordEventPayload & { previousOwnerId: string | null };
  'message.received': MessageEventPayload;
  'message.sent': MessageEventPayload;
  'call.started': CallEventPayload;
  'call.ended': CallEventPayload;
  'lead.captured': { recordId: string; source: string; raw: unknown };
  'form.submitted': { webformId: string; recordId: string; module: string };
  'notification.created': { userId: string; notificationId: string };
}

type EventName = keyof EventMap;
type Handler<K extends EventName> = (payload: EventMap[K]) => void | Promise<void>;

const handlers = new Map<EventName, Set<Handler<EventName>>>();

export function on<K extends EventName>(event: K, handler: Handler<K>): () => void {
  const set = handlers.get(event) ?? new Set();
  set.add(handler as Handler<EventName>);
  handlers.set(event, set);
  return () => set.delete(handler as Handler<EventName>);
}

/**
 * Fire an event. Handlers run concurrently; a rejection is logged and swallowed
 * so downstream automation can never break the originating request.
 */
export async function emit<K extends EventName>(event: K, payload: EventMap[K]): Promise<void> {
  const set = handlers.get(event);
  if (!set || set.size === 0) return;
  const results = await Promise.allSettled([...set].map((h) => h(payload)));
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.error({ err: r.reason, event }, 'event handler failed');
    }
  }
}

/** Fire and forget — used where the caller must not wait on automation. */
export function emitAsync<K extends EventName>(event: K, payload: EventMap[K]): void {
  void emit(event, payload).catch((err) => logger.error({ err, event }, 'async emit failed'));
}

export const bus = { on, emit, emitAsync };
