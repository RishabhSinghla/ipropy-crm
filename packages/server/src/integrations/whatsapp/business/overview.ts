/**
 * Everything about WhatsApp, on one screen, in the CRM.
 *
 * **The owner's words, 20 September 2026:** *"I don't understand this
 * whatsmarketing but I need similar sort of thing inside our CRM built
 * completely upon whatsmarketing so maybe never ever in this life I would be
 * required to open whatsmarketing."*
 *
 * That is the right instinct and it has a limit worth writing down. A vendor's
 * dashboard holds three kinds of thing: what they know about *our* messages,
 * what they hold on *their* side, and what belongs to Meta. The first is
 * already ours — it is in this database. The second we can ask for. The third
 * (the number's quality rating, its messaging tier, the business verification)
 * lives in Meta's own system and no reseller API exposes it. So the honest
 * target is "twice a year", not "never", and this screen says so rather than
 * quietly leaving a gap somebody discovers at the worst moment.
 *
 * Everything here is read from rows the CRM already owns. **No vendor call**,
 * deliberately: a control screen that goes dark because a third party is
 * having an afternoon is worse than no control screen, and the one number that
 * genuinely needs their API — whether the poller can still reach them — is
 * already recorded every minute by the poller itself.
 */
import { db } from '../../../db/pool.js';
import { getIntegrationConfig } from '../../../core/settings/integrations.js';
import { activeBusinessProvider } from './registry.js';

export interface WhatsAppOverview {
  provider: string | null;
  connected: boolean;
  businessNumber: string | null;
  capabilities: string[];
  /** What the inbound check said last time it ran, and when. */
  lastCheck: { at: string; ok: boolean; detail: string } | null;
  conversations: { total: number; windowOpen: number; unlinked: number; unread: number };
  messages: { inboundToday: number; outboundToday: number; failedToday: number; deliveredToday: number };
  templates: { total: number; approved: number; unmapped: number };
  /** What still needs their dashboard, so nobody goes looking for it here. */
  stillTheirs: string[];
}

const STILL_THEIRS = [
  'Connecting a new WhatsApp number (a one-off Meta handshake)',
  'Paying WhatsMarketing, and changing plan',
  'Switching on the delivery webhook — their support team does it',
  'The number’s quality rating and daily limit, which live in Meta’s own system',
];

export async function whatsAppOverview(): Promise<WhatsAppOverview> {
  const provider = activeBusinessProvider();

  /*
    One query per question rather than one clever one. These are read by a
    person deciding whether something is wrong, and a wrong join in a single
    monster query is a wrong answer nobody can spot.
  */
  const conversations = await db.queryOne<{
    total: string; window_open: string; unlinked: string; unread: string;
  }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE window_expires_at > now())        AS window_open,
            COUNT(*) FILTER (WHERE record_id IS NULL)                AS unlinked,
            COUNT(*) FILTER (WHERE unread_count > 0)                 AS unread
       FROM ipy_conversation
      WHERE channel = 'whatsapp'`,
  );

  const messages = await db.queryOne<{
    inbound: string; outbound: string; failed: string; delivered: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE m.direction = 'inbound')                        AS inbound,
            COUNT(*) FILTER (WHERE m.direction = 'outbound')                       AS outbound,
            COUNT(*) FILTER (WHERE m.direction = 'outbound' AND m.status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE m.status IN ('delivered','read'))               AS delivered
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
      WHERE c.channel = 'whatsapp' AND m.created_at >= date_trunc('day', now())`,
  );

  const templates = await db.queryOne<{ total: string; approved: string; unmapped: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE upper(status) = 'APPROVED') AS approved,
            -- A template with blanks and no mapping cannot be sent to anybody,
            -- which is the one template fact worth surfacing here.
            -- The column is body_text. This line once read body, which does
            -- not exist on this table, so Postgres refused the whole statement
            -- (42703), the route answered 500, and the Health page sat on its
            -- loading skeleton for ever with nothing on screen to say why.
            COUNT(*) FILTER (
              WHERE COALESCE(variable_map::text, '{}') IN ('{}', 'null')
                AND body_text LIKE '%{{%'
            ) AS unmapped
       FROM ipy_whatsapp_template`,
  );

  const poll = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'whatsapp.last_poll'`,
  );
  const raw = (poll?.value ?? null) as { at?: string; ok?: boolean; detail?: string } | null;

  return {
    provider: provider?.name ?? null,
    connected: provider ? await provider.isConfigured() : false,
    businessNumber: provider
      ? await provider.businessNumber()
      // No provider switched on, so fall back to whatever was typed into the
      // card — the number is still worth showing while somebody fixes the
      // switch. `?? {}` because the config may be absent entirely.
      : ((getIntegrationConfig('whatsapp_whatsmarketing') ?? {}).businessNumber ?? null),
    capabilities: provider ? [...provider.capabilities] : [],
    lastCheck: raw?.at ? { at: raw.at, ok: Boolean(raw.ok), detail: String(raw.detail ?? '') } : null,
    conversations: {
      total: Number(conversations?.total ?? 0),
      windowOpen: Number(conversations?.window_open ?? 0),
      unlinked: Number(conversations?.unlinked ?? 0),
      unread: Number(conversations?.unread ?? 0),
    },
    messages: {
      inboundToday: Number(messages?.inbound ?? 0),
      outboundToday: Number(messages?.outbound ?? 0),
      failedToday: Number(messages?.failed ?? 0),
      deliveredToday: Number(messages?.delivered ?? 0),
    },
    templates: {
      total: Number(templates?.total ?? 0),
      approved: Number(templates?.approved ?? 0),
      unmapped: Number(templates?.unmapped ?? 0),
    },
    stillTheirs: STILL_THEIRS,
  };
}
