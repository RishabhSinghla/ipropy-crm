/**
 * What the WhatsApp number actually did — the last thing on the owner's list
 * for this route, after the inbox, the templates, the media, sharing a unit
 * and campaigns.
 *
 * Three questions, and no more, because these are the three somebody asks:
 * how much came in and went out, what happened to the messages we sent, and
 * how each campaign ended. Everything here is counted from the CRM's own rows
 * rather than from a vendor's dashboard — which is the rule this whole phase
 * was built on, and is why the numbers survive changing provider.
 *
 * **Who sees what is the inbox's rule, not a new one.** An admin sees every
 * thread; everybody else sees their own and the unassigned queue. A report
 * that counted every message regardless would tell a rep exactly how many
 * conversations colleagues are having, which is the thing the shared inbox
 * deliberately does not show.
 */
import { db } from '../../../db/pool.js';
import { visibility } from './inbox.js';

export interface MessagingReport {
  days: number;
  byDay: { day: string; inbound: number; outbound: number }[];
  outcomes: { status: string; count: number }[];
  campaigns: { id: string; name: string; status: string; sent: number; failed: number; skipped: number; pending: number }[];
  totals: { inbound: number; outbound: number; conversations: number };
}

export async function messagingReport(input: {
  userId: string; isAdmin: boolean; days: number;
}): Promise<MessagingReport> {
  const days = Math.min(Math.max(input.days, 1), 365);
  const params: unknown[] = [];
  const see = visibility(input.userId, input.isAdmin, params.length + 1);
  params.push(...see.params);
  // The window is its own parameter rather than interpolated, and cast where it
  // is used: a bare `$n` beside `interval` deduces two types and Postgres
  // refuses the whole statement — the trap this route's neighbours already hit.
  const windowIndex = params.length + 1;
  params.push(String(days));

  const where = `c.channel = 'whatsapp' AND ${see.clause}
    AND m.created_at >= now() - ($${windowIndex}::text || ' days')::interval`;

  const byDay = await db.query<{ day: string; inbound: number; outbound: number }>(
    `SELECT to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE m.direction = 'inbound')::int  AS inbound,
            COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound
       FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
      WHERE ${where}
      GROUP BY 1 ORDER BY 1`,
    params,
  );

  const outcomes = await db.query<{ status: string; count: number }>(
    `SELECT m.status, COUNT(*)::int AS count
       FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
      WHERE ${where} AND m.direction = 'outbound'
      GROUP BY 1 ORDER BY 2 DESC`,
    params,
  );

  const totals = await db.queryOne<{ inbound: number; outbound: number; conversations: number }>(
    `SELECT COUNT(*) FILTER (WHERE m.direction = 'inbound')::int  AS inbound,
            COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound,
            COUNT(DISTINCT c.id)::int AS conversations
       FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
      WHERE ${where}`,
    params,
  );

  /*
    Campaigns are a manager's view by nature — one goes to hundreds of people
    at once and its outcome is not a per-conversation fact — so a rep who
    cannot see the whole inbox is not shown them either, rather than shown a
    number that means something different to them than to everybody else.
  */
  const campaigns = input.isAdmin
    ? (await db.query<{ id: string; name: string; status: string; sent: number; failed: number; skipped: number; pending: number }>(
      `SELECT ca.id, ca.name, ca.status,
              COUNT(r.*) FILTER (WHERE r.status = 'sent')::int    AS sent,
              COUNT(r.*) FILTER (WHERE r.status = 'failed')::int  AS failed,
              COUNT(r.*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
              COUNT(r.*) FILTER (WHERE r.status = 'pending')::int AS pending
         FROM ipy_campaign ca
         LEFT JOIN ipy_campaign_recipient r ON r.campaign_id = ca.id
        WHERE ca.created_at >= now() - ($1::text || ' days')::interval
        GROUP BY ca.id ORDER BY ca.created_at DESC LIMIT 20`,
      [String(days)],
    )).rows
    : [];

  return {
    days,
    byDay: byDay.rows,
    outcomes: outcomes.rows,
    campaigns,
    totals: totals ?? { inbound: 0, outbound: 0, conversations: 0 },
  };
}
