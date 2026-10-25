/**
 * Which WhatsApp route does which job.
 *
 *  - **automation**: the official API. Workflow messages ("lead became New"),
 *    first messages and approved templates. Admin-only to look at.
 *  - **chat**: the linked phone (OpenWA). Ordinary conversation once a lead replies.
 *
 * Until an admin sets at least one of them, nothing here has any effect and the
 * CRM keeps its older rule of exactly one active WhatsApp card.
 *
 * Held in memory and refreshed with the integration cards, because the routing
 * question is asked on every send and every screen load and must not be a query.
 */
import { db } from '../../../db/pool.js';

export const ROLES_SETTING_KEY = 'whatsapp.channel_roles';

export interface ChannelRoles { automation: string | null; chat: string | null }

let roles: ChannelRoles = { automation: null, chat: null };

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('whatsapp_') ? value : null;
}

export function parseRoles(value: unknown): ChannelRoles {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { automation: clean(v.automation), chat: clean(v.chat) };
}

/** Called whenever the integration cards reload, so the two never disagree. */
export async function loadChannelRoles(): Promise<void> {
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = $1`, [ROLES_SETTING_KEY],
  ).catch(() => null);
  roles = parseRoles(row?.value);
}

export function channelRoles(): ChannelRoles { return roles; }

/** Sets the in-memory copy only; the database write is `saveChannelRoles`. */
export function setChannelRolesInMemory(next: ChannelRoles): void { roles = parseRoles(next); }

/** True once an admin has chosen at least one role. */
export function rolesInUse(): boolean { return Boolean(roles.automation || roles.chat); }

export async function saveChannelRoles(next: ChannelRoles): Promise<ChannelRoles> {
  const value = parseRoles(next);
  await db.query(
    `INSERT INTO ipy_setting (key, value, category, label, description)
     VALUES ($1, $2::jsonb, 'whatsapp', 'WhatsApp channel roles',
             'Which WhatsApp route sends automatic messages and which handles chat')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ROLES_SETTING_KEY, JSON.stringify(value)],
  );
  roles = value;
  return value;
}

/**
 * True when this provider is the automation route and a different one handles
 * chat, i.e. its outgoing messages are the ones only an admin gets to read.
 */
export function isAutomationOnlyProvider(providerName: string | null | undefined): boolean {
  if (!providerName || !rolesInUse()) return false;
  const { automation, chat } = roles;
  return Boolean(automation && automation === providerName && chat !== providerName);
}

/** What everyone but an admin reads in place of an automatic message. */
export const AUTOMATIC_MESSAGE_TEXT = 'Automatic WhatsApp message sent';

/**
 * Hides automatic messages from everyone but admins, on the server.
 *
 * Replies from the customer are never touched: they are the lead's own words
 * and any rep who can see the lead must see them. Only what the official API
 * sent out is replaced, and the provider column is dropped from every row so
 * no screen can show which route was used.
 */
export function redactAutomated<T extends Record<string, unknown>>(rows: T[], isAdmin: boolean): Record<string, unknown>[] {
  return rows.map((row) => {
    const { provider, ...rest } = row;
    const automated = row.direction === 'outbound' && isAutomationOnlyProvider(provider as string | null);
    if (!automated) return rest;
    if (isAdmin) return { ...rest, automated: true };
    return {
      ...rest,
      automated: true,
      type: 'text',
      body: AUTOMATIC_MESSAGE_TEXT,
      media: null,
      template_name: null,
      error_message: null,
      sent_by_name: null,
    };
  });
}

/** The route whose outgoing messages stay private to admins, or null when there is none. */
export function automationOnlyRoute(): string | null {
  return roles.automation && roles.automation !== roles.chat ? roles.automation : null;
}
