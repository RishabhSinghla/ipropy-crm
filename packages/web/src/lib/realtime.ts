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
import { api, tokenStore } from './api';
import { invalidateRecordQueries } from './invalidate';
import { apiBase, isNative } from './native';
import { callSyncSupported, placeCallFromPhone } from './callSync';
import { dial } from './nativeActions';

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
    /*
      The CRM telling this phone to ring somebody.

      Only the phone acts on it. The same event reaches the rep's laptop, where
      there is nothing to do with it — that is deliberate rather than wasteful:
      one event to the person, and whichever of their screens can actually
      place a call does. The command is claimed by id so the phone's background
      sync does not ring the same number a second time.
    */
    const onDial = (p: { commandId?: string; number?: string }): void => {
      if (!isNative || !p?.number) return;
      const number = p.number;
      void (async () => {
        const placed = callSyncSupported
          ? await placeCallFromPhone(number, p.commandId)
          : { placed: false, reason: 'not-android' };
        if (placed.placed) return;
        /*
          The app on this phone cannot place the call itself — which today is
          *every* installed copy, because they all predate `placeCall`. Its own
          webview still has a dialler, so the number goes there with the digits
          already in it and the rep presses the green button.

          Without this the instruction is simply never collected: 130 of them
          on production, every one expired, which on the desk reads as "your
          phone did not ring" and gives a rep nothing to do about it.
        */
        dial(number);
        if (p.commandId) {
          try {
            await api.closeDial(p.commandId, { ok: true, via: 'dialler' });
          } catch {
            // The call is already dialling. A desk that never hears back falls
            // back on its own, which is a worse message and not a worse call.
          }
        }
      })();
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
    s.on('device:dial', onDial);

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
      s.off('device:dial', onDial);
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
