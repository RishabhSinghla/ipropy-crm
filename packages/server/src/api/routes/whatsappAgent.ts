import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getScope, getUser, requireAuth } from '../../middleware/auth.js';
import * as agent from '../../integrations/whatsapp/agent/service.js';
import * as claim from '../../integrations/whatsapp/agent/claim.js';
import { recordService } from '../../core/entity/recordService.js';
import QRCode from 'qrcode';

/**
 * The QR as a picture, drawn here rather than in the browser.
 *
 * WhatsApp hands back the raw payload, which is useless to a person. Rendering
 * it server-side keeps the payload off the page as text — it is, briefly, the
 * thing that links a device to somebody's account — and means no QR library in
 * the bundle every user downloads for a screen most of them open once.
 */
async function asImage(qr: string | null): Promise<string | null> {
  if (!qr) return null;
  return QRCode.toDataURL(qr, { margin: 1, width: 280 }).catch(() => null);
}

/**
 * Agent-linked WhatsApp, over HTTP.
 *
 * Not one route here takes an account id. Every call resolves the *signed-in
 * user's* own account, so there is no request shape that reaches a colleague's
 * session — which is the isolation rule made structural rather than checked.
 *
 * `blockApiKey` throughout: an API key belongs to an assistant, and linking,
 * unlinking or sending from somebody's personal WhatsApp is not something an
 * assistant does on their behalf.
 */
export const whatsappAgentRouter = Router();
whatsappAgentRouter.use(requireAuth, blockApiKey);

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

whatsappAgentRouter.get('/me', asyncHandler(async (req, res) => {
  const state = await agent.linkState(getUser(req).id);
  res.json({ ...state, qr: await asImage(state.qr) });
}));

whatsappAgentRouter.post('/link', asyncHandler(async (req, res) => {
  const { label } = z.object({ label: z.string().trim().max(60).optional() }).parse(req.body ?? {});
  const user = getUser(req);
  const state = await agent.startLink(user.id, label ?? `${user.fullName ?? 'My'} WhatsApp`);
  res.json({ ...state, qr: await asImage(state.qr) });
}));

whatsappAgentRouter.post('/unlink', asyncHandler(async (req, res) => {
  await agent.unlink(getUser(req).id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

whatsappAgentRouter.post('/send', asyncHandler(async (req, res) => {
  const input = z.object({
    to: z.string().trim().min(8),
    text: z.string().trim().min(1).max(4096),
  }).parse(req.body);
  res.json(await agent.sendAsAgent({ userId: getUser(req).id, ...input }));
}));

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * The agent's own threads, newest first.
 *
 * Scoped by account, so this is what *their* linked number can see. A manager
 * reading somebody else's history does it through the contact, where the CRM's
 * own permissions apply — not by borrowing this list.
 */
whatsappAgentRouter.get('/conversations', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const unreadOnly = req.query.unread === 'true';
  const { rows } = await db.query(
    `SELECT c.id, c.handle, c.contact_name, c.record_id, c.record_module,
            c.unread_count, c.last_message_at, c.last_message_preview,
            r.label AS record_label
       FROM ipy_conversation c
       JOIN ipy_wa_account a ON a.id = c.wa_account_id
       LEFT JOIN ipy_record r ON r.id = c.record_id AND r.is_deleted = false
      WHERE a.user_id = $1 AND c.channel = 'whatsapp' AND c.status <> 'resolved'
        AND ($2::boolean = false OR c.unread_count > 0)
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 200`,
    [user.id, unreadOnly],
  );
  res.json(rows);
}));

whatsappAgentRouter.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const user = getUser(req);
  // The join to the account is the permission check: a conversation on somebody
  // else's linked number simply is not found.
  const { rows } = await db.query(
    `SELECT m.id, m.direction, m.body, m.type, m.status, m.created_at, m.media, m.sent_by
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
       JOIN ipy_wa_account a ON a.id = c.wa_account_id
      WHERE c.id = $1 AND a.user_id = $2
      ORDER BY m.created_at
      LIMIT 500`,
    [req.params.id, user.id],
  );
  res.json(rows);
}));

/** Opening a thread is what clears its unread count — not receiving it. */
whatsappAgentRouter.post('/conversations/:id/read', asyncHandler(async (req, res) => {
  await db.query(
    `UPDATE ipy_conversation c
        SET unread_count = 0
       FROM ipy_wa_account a
      WHERE c.id = $1 AND a.id = c.wa_account_id AND a.user_id = $2`,
    [req.params.id, getUser(req).id],
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Numbers nobody recognises
// ---------------------------------------------------------------------------

whatsappAgentRouter.get('/unmatched', asyncHandler(async (req, res) => {
  res.json(await claim.listUnmatched(getUser(req).id));
}));

whatsappAgentRouter.post('/unmatched/:id/link', asyncHandler(async (req, res) => {
  const { recordId } = z.object({ recordId: z.string().uuid() }).parse(req.body);
  await claim.linkExisting(getUser(req).id, req.params.id, recordId);
  res.json({ ok: true });
}));

whatsappAgentRouter.post('/unmatched/:id/create', asyncHandler(async (req, res) => {
  const { values } = z.object({ values: z.record(z.unknown()) }).parse(req.body);
  res.json(await claim.createContact(getScope(req), req.params.id, values));
}));

whatsappAgentRouter.post('/unmatched/:id/ignore', asyncHandler(async (req, res) => {
  await claim.ignore(getUser(req).id, req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// A contact's WhatsApp history
// ---------------------------------------------------------------------------

/**
 * Everything said to this person on WhatsApp, by anybody.
 *
 * Deliberately *not* scoped to the reader's own linked account. This is the
 * contact's history, and who may read it is the CRM's own question — so the
 * record is fetched through `recordService`, which applies the profile, the
 * role hierarchy and the sharing rules before a single message is read. A
 * manager who can open the lead can read its conversation; somebody who cannot
 * open the lead gets the same 404 they would get anywhere else.
 *
 * That is how §12's manager visibility works without anybody borrowing an
 * agent's session: authority comes from the contact, never from the phone.
 */
whatsappAgentRouter.get('/contacts/:module/:id/messages', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  // Throws NotFound/Forbidden exactly as opening the record would.
  await recordService.getRecord(scope, req.params.module, req.params.id);

  const { rows } = await db.query(
    `SELECT m.id, m.direction, m.body, m.type, m.status, m.created_at, m.media,
            m.sent_by, u.first_name, u.last_name,
            a.label AS account_label, a.phone_number AS account_number
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
       LEFT JOIN ipy_wa_account a ON a.id = m.wa_account_id
       LEFT JOIN ipy_user u ON u.id = a.user_id
      WHERE c.record_id = $1 AND c.channel = 'whatsapp'
      ORDER BY m.created_at
      LIMIT 500`,
    [req.params.id],
  );

  res.json(rows.map((row) => {
    const r = row as Record<string, unknown>;
    const first = (r.first_name as string | null) ?? '';
    const last = (r.last_name as string | null) ?? '';
    const agent = `${first} ${last}`.trim();
    return {
      id: r.id, direction: r.direction, body: r.body, type: r.type,
      status: r.status, createdAt: r.created_at, media: r.media,
      // "Sent via Sheetal's WhatsApp" — who it went out as, which is the whole
      // point of per-agent numbers and the one thing a shared inbox cannot say.
      sentVia: agent ? `${agent}${r.account_number ? ` (${r.account_number})` : ''}` : (r.account_label as string | null),
    };
  }));
}));
