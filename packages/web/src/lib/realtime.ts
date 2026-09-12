/**
 * Realtime client.
 *
 * The server has always broadcast domain events over Socket.IO, but nothing on
 * the client ever connected — so anything the server changed after responding
 * (workflow tasks, AI scoring, assignment rules, another user's edit) stayed
 * invisible until a manual page refresh. This connects that layer up and turns
 * each event into the matching cache invalidation.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { tokenStore } from './api';
import { invalidateRecordQueries } from './invalidate';
import { apiBase } from './native';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  return socket;
}

function connect(token: string): Socket {
  if (socket) return socket;
  /*
    Same origin in dev via the Vite proxy, same origin in production behind the
    reverse proxy — so in a browser there is no URL to give and `io()` finds
    the server on its own.

    The app is the exception: its page comes from inside the installed bundle,
    so "same origin" is the bundle, which serves nothing. Left to guess, the
    socket dials `https://localhost/socket.io` and retries for ever, and the
    symptom is not an error — it is a CRM that works perfectly except that
    nothing another person does ever appears.
  */
  socket = io(apiBase() || undefined, {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  return socket;
}

export function disconnectRealtime(): void {
  socket?.disconnect();
  socket = null;
}

/**
 * Mounted once in the app shell. Keeps a single socket alive for the session
 * and maps server events onto query invalidations.
 */
export function useRealtime(enabled: boolean): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    const token = tokenStore.get();
    if (!token) return;

    const s = connect(token);

    const onRecordChanged = (p: { module?: string; recordId?: string }): void => {
      invalidateRecordQueries(qc, p?.module, p?.recordId);
    };
    const onTimeline = (p: { recordId?: string }): void => {
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      if (p?.recordId) void qc.invalidateQueries({ queryKey: ['insights', p.recordId] });
    };
    const onInbox = (): void => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['conversation'] });
    };
    const onNotification = (): void => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    };
    const onCall = (): void => {
      void qc.invalidateQueries({ queryKey: ['calls'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
    };
    const onLead = (): void => {
      invalidateRecordQueries(qc, 'leads');
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    };

    s.on('record:updated', onRecordChanged);
    s.on('record:created', onRecordChanged);
    s.on('module:changed', onRecordChanged);
    s.on('timeline:refresh', onTimeline);
    s.on('message', onInbox);
    s.on('inbox:update', onInbox);
    s.on('notification', onNotification);
    s.on('call:incoming', onCall);
    s.on('call:ended', onCall);
    s.on('lead:new', onLead);

    return () => {
      s.off('record:updated', onRecordChanged);
      s.off('record:created', onRecordChanged);
      s.off('module:changed', onRecordChanged);
      s.off('timeline:refresh', onTimeline);
      s.off('message', onInbox);
      s.off('inbox:update', onInbox);
      s.off('notification', onNotification);
      s.off('call:incoming', onCall);
      s.off('call:ended', onCall);
      s.off('lead:new', onLead);
    };
  }, [enabled, qc]);
}

/**
 * Subscribe to one conversation's room while its thread is open.
 *
 * `inbox:update` already reaches whoever the thread is assigned to, but the
 * per-message event goes to this room only — so without joining it, a reply
 * sent from somebody else's screen, or a linked phone confirming that a queued
 * message actually left, arrives only on the next poll. That is the difference
 * between a chat window and a page that refreshes.
 */
export function useWatchConversation(conversationId: string | undefined): void {
  useEffect(() => {
    if (!conversationId) return;
    const s = getSocket();
    if (!s) return;
    const join = (): void => { s.emit('watch:conversation', conversationId); };
    join();
    // Rooms are lost on reconnect, so re-join rather than assuming membership.
    s.on('connect', join);
    return () => { s.off('connect', join); };
  }, [conversationId]);
}

/**
 * Subscribe to one record's room while its detail page is open, so server-side
 * changes to that record (workflow updates, AI insights) arrive immediately.
 */
export function useWatchRecord(recordId: string | undefined): void {
  useEffect(() => {
    if (!recordId) return;
    const s = getSocket();
    if (!s) return;
    const join = (): void => { s.emit('watch:record', recordId); };
    join();
    // Re-join after a reconnect, otherwise the room membership is lost.
    s.on('connect', join);
    return () => {
      s.off('connect', join);
      s.emit('unwatch:record', recordId);
    };
  }, [recordId]);
}
