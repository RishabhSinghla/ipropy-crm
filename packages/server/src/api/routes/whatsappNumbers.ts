/**
 * Admin: the company's WhatsApp numbers (one OpenWA session per agent) and who works from which.
 * Everything here except `GET /mine` is admin-only. See integrations/whatsapp/business/waNumbers.ts for the rules.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getUser, requireAdmin, requireAuth } from '../../middleware/auth.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import {
  assignNumber, chooseNumber, controlSession, createNumber, connectWebhook, listNumbers, numberOfUser, qrFor, setDefaultNumber,
  setPaused, syncFromOpenWa, updateLabel,
} from '../../integrations/whatsapp/business/waNumbers.js';

export const whatsappNumbersRouter = Router();
whatsappNumbersRouter.use(requireAuth, blockApiKey);

/** Any signed-in user: which number am I, and is it usable. Admins also get the full list (for the number switcher). */
whatsappNumbersRouter.get('/mine', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const [mine, all] = await Promise.all([numberOfUser(user.id), user.isAdmin ? listNumbers() : Promise.resolve([])]);
  res.json({ mine, numbers: all });
}));

/** Who will a send from this record go out as, for the signed-in user? The composer shows it before anything is sent. */
whatsappNumbersRouter.get('/choose', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const recordId = typeof req.query.recordId === 'string' ? req.query.recordId : null;
  const owner = recordId && /^[0-9a-f-]{36}$/i.test(recordId)
    ? (await db.queryOne<{ owner_id: string | null }>(`SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId]))?.owner_id ?? null
    : null;
  try {
    const pick = await chooseNumber({ userId: user.id, isAdmin: user.isAdmin, recordOwnerId: owner });
    res.json({ number: pick.number, fallbackNote: pick.fallbackNote, error: null });
  } catch (err) {
    res.json({ number: null, fallbackNote: null, error: (err as Error).message });
  }
}));

const admin = Router();
admin.use(requireAdmin);

admin.get('/', asyncHandler(async (_req, res) => { res.json(await listNumbers()); }));
admin.post('/refresh', asyncHandler(async (_req, res) => { res.json(await syncFromOpenWa()); }));

admin.post('/', asyncHandler(async (req, res) => {
  const body = z.object({ sessionName: z.string(), label: z.string().optional() }).parse(req.body ?? {});
  const origin = `${req.get('x-forwarded-proto') ?? req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`;
  const created = await createNumber({ ...body, webhookUrl: `${origin}/api/webhooks/whatsapp/openwa` });
  logger.info({ by: getUser(req).id, session: created.sessionName }, 'whatsapp number created');
  res.json(created);
}));

admin.post('/:id/webhook', asyncHandler(async (req, res) => {
  const origin = `${req.get('x-forwarded-proto') ?? req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`;
  await connectWebhook(req.params.id, `${origin}/api/webhooks/whatsapp/openwa`);
  res.json({ ok: true });
}));

admin.post('/:id/control', asyncHandler(async (req, res) => {
  const { action } = z.object({ action: z.enum(['start', 'stop', 'restart', 'unlink']) }).parse(req.body ?? {});
  logger.info({ by: getUser(req).id, number: req.params.id, action }, 'whatsapp number control');
  res.json(await controlSession(req.params.id, action));
}));

admin.get('/:id/qr', asyncHandler(async (req, res) => { res.json(await qrFor(req.params.id)); }));

admin.put('/:id/assign', asyncHandler(async (req, res) => {
  const { userId } = z.object({ userId: z.string().uuid().nullable() }).parse(req.body ?? {});
  logger.info({ by: getUser(req).id, number: req.params.id, userId }, 'whatsapp number assigned');
  res.json(await assignNumber(req.params.id, userId));
}));

admin.put('/:id/default', asyncHandler(async (req, res) => { res.json(await setDefaultNumber(req.params.id)); }));

admin.put('/:id/pause', asyncHandler(async (req, res) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(req.body ?? {});
  logger.info({ by: getUser(req).id, number: req.params.id, paused }, 'whatsapp number pause switch');
  res.json(await setPaused(req.params.id, paused, getUser(req).id));
}));

admin.put('/:id/label', asyncHandler(async (req, res) => {
  const { label } = z.object({ label: z.string().max(80) }).parse(req.body ?? {});
  res.json(await updateLabel(req.params.id, label));
}));

/** Who sent what from which number (the audit trail), newest first. */
admin.get('/log/sends', asyncHandler(async (req, res) => {
  const numberId = typeof req.query.numberId === 'string' ? req.query.numberId : null;
  const { rows } = await db.query(
    `SELECT m.id, m.created_at, m.status, left(coalesce(m.body, ''), 120) AS body, c.handle,
            trim(u.first_name || ' ' || u.last_name) AS sent_by_name,
            coalesce(n.label, n.session_name) AS number_label
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
       LEFT JOIN ipy_user u ON u.id = m.sent_by
       LEFT JOIN ipy_wa_number n ON n.id = m.number_id
      WHERE m.provider = 'whatsapp_openwa' AND m.direction = 'outbound' AND m.sent_by IS NOT NULL
        AND ($1::uuid IS NULL OR m.number_id = $1::uuid)
      ORDER BY m.created_at DESC LIMIT 200`,
    [numberId],
  );
  res.json(rows);
}));

whatsappNumbersRouter.use('/', admin);
