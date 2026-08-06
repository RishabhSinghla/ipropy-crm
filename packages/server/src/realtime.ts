/**
 * Realtime layer (Socket.IO).
 *
 * Pushes notifications, inbox updates and record changes to connected clients
 * so the inbox and dashboards feel live without polling. Each socket joins a
 * room per user id, so a message only reaches the people it belongs to.
 */
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { verifyAccessToken, loadUser } from './middleware/auth.js';
import { bus } from './core/events/bus.js';
import { db } from './db/pool.js';

let io: Server | null = null;

export function initRealtime(server: HttpServer): Server {
  io = new Server(server, {
    cors: {
      origin: config.isProd ? config.appUrl.split(',').map((s) => s.trim()) : true,
      credentials: true,
    },
    path: '/socket.io',
  });

  io.use(async (socket: Socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string | undefined)
        ?? (socket.handshake.headers.authorization as string | undefined)?.replace('Bearer ', '');
      if (!token) return next(new Error('unauthorized'));

      const payload = verifyAccessToken(token);
      const user = await loadUser(payload.sub);
      if (!user?.isActive) return next(new Error('unauthorized'));

      socket.data.user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as { id: string; groupIds: string[]; isAdmin: boolean };
    socket.join(`user:${user.id}`);
    for (const groupId of user.groupIds ?? []) socket.join(`group:${groupId}`);
    if (user.isAdmin) socket.join('admins');

    logger.debug({ userId: user.id }, 'socket connected');

    // Watch a record's detail page for live timeline updates.
    socket.on('watch:record', (recordId: string) => {
      if (typeof recordId === 'string' && /^[0-9a-f-]{36}$/i.test(recordId)) {
        socket.join(`record:${recordId}`);
      }
    });
    socket.on('unwatch:record', (recordId: string) => {
      socket.leave(`record:${recordId}`);
    });

    socket.on('watch:conversation', (conversationId: string) => {
      if (typeof conversationId === 'string' && /^[0-9a-f-]{36}$/i.test(conversationId)) {
        socket.join(`conversation:${conversationId}`);
      }
    });

    socket.on('disconnect', () => {
      logger.debug({ userId: user.id }, 'socket disconnected');
    });
  });

  wireEvents();
  logger.info('realtime layer ready');
  return io;
}

function emitTo(room: string, event: string, payload: unknown): void {
  io?.to(room).emit(event, payload);
}

/** Tell every client that some record in this module changed. Name only. */
function broadcastModuleChange(module: string): void {
  io?.emit('module:changed', { module });
}

function wireEvents(): void {
  bus.on('message.received', async (p) => {
    emitTo(`conversation:${p.conversationId}`, 'message', { ...p, direction: 'inbound' });

    const conv = await db.queryOne<{ assigned_to: string | null; contact_name: string | null }>(
      `SELECT assigned_to, contact_name FROM ipy_conversation WHERE id = $1`, [p.conversationId],
    );
    // Unassigned threads go to everyone so nothing sits unanswered.
    const room = conv?.assigned_to ? `user:${conv.assigned_to}` : 'admins';
    emitTo(room, 'inbox:update', {
      conversationId: p.conversationId,
      preview: p.body,
      contactName: conv?.contact_name,
      handle: p.handle,
    });
  });

  bus.on('message.sent', (p) => {
    emitTo(`conversation:${p.conversationId}`, 'message', { ...p, direction: 'outbound' });
  });

  bus.on('record.updated', (p) => {
    emitTo(`record:${p.recordId}`, 'record:updated', {
      module: p.module,
      recordId: p.recordId,
      changedFields: p.changedFields,
      updatedBy: p.user?.fullName ?? 'System',
    });
    broadcastModuleChange(p.module);
  });

  bus.on('record.created', (p) => {
    // Let list views know something new arrived in their module.
    io?.emit('record:created', { module: p.module, recordId: p.recordId });
  });

  // List views, dashboards and reports aggregate a whole module, so they need
  // to hear about every write - not just writes to a record they are watching.
  // Only the module name is broadcast: the payload deliberately carries no
  // record id, so this cannot reveal the existence of a record the recipient
  // is not allowed to see. Clients treat it purely as a cache-invalidation
  // hint and re-fetch through the normal permission-scoped endpoints.
  bus.on('record.deleted', (p) => broadcastModuleChange(p.module));
  bus.on('record.restored', (p) => broadcastModuleChange(p.module));
  bus.on('record.owner_changed', (p) => broadcastModuleChange(p.module));
  bus.on('record.converted', (p) => broadcastModuleChange(p.module));

  bus.on('call.started', (p) => {
    if (p.userId) emitTo(`user:${p.userId}`, 'call:incoming', p);
  });

  bus.on('call.ended', (p) => {
    if (p.userId) emitTo(`user:${p.userId}`, 'call:ended', p);
    if (p.recordId) emitTo(`record:${p.recordId}`, 'timeline:refresh', { recordId: p.recordId });
  });

  bus.on('lead.captured', async (p) => {
    const owner = await db.queryOne<{ owner_id: string | null; label: string }>(
      `SELECT owner_id, label FROM ipy_record WHERE id = $1`, [p.recordId],
    );
    const room = owner?.owner_id ? `user:${owner.owner_id}` : 'admins';
    emitTo(room, 'lead:new', { recordId: p.recordId, label: owner?.label, source: p.source });
  });

  bus.on('notification.created', (p) => {
    emitTo(`user:${p.userId}`, 'notification', p);
  });
}

/** Push a notification to a specific user from anywhere in the app. */
export function pushNotification(userId: string, payload: Record<string, unknown>): void {
  emitTo(`user:${userId}`, 'notification', payload);
}

export function closeRealtime(): void {
  io?.close();
  io = null;
}

export function getIo(): Server | null {
  return io;
}
