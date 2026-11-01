/**
 * Which of OUR numbers carried each message.
 *
 * Plain chat messages carry the OpenWA number they went through (`number_id`); official-API
 * messages carry the business number from the provider's card. Received messages say which of
 * our numbers received them. The label is decided here, once, so the inbox and the lead tab
 * cannot disagree about it.
 */
import { db } from '../../../db/pool.js';
import { getIntegrationConfig } from '../../../core/settings/integrations.js';
import { maskPhone } from './openwa.js';
import { CHAT_PROVIDER } from './channelRoles.js';

export interface SenderLabel { numberId: string | null; numberName: string | null; numberPhone: string | null }

function apiLabel(provider: string | null): SenderLabel {
  const config = (provider ? getIntegrationConfig(provider) : null) ?? {};
  const name = typeof config.businessName === 'string' && config.businessName.trim() ? config.businessName.trim() : 'WhatsApp API';
  const phone = typeof config.businessNumber === 'string' && config.businessNumber.trim() ? config.businessNumber.trim() : null;
  return { numberId: provider ? `api:${provider}` : null, numberName: name, numberPhone: phone };
}

/** Adds numberId / numberName / numberPhone to each row. Needs `provider` and `number_id` on the rows. */
export async function withSenderLabels<T extends Record<string, unknown>>(rows: T[]): Promise<Array<T & SenderLabel>> {
  const ids = [...new Set(rows.map((r) => r.number_id).filter((v): v is string => typeof v === 'string'))];
  const known = new Map<string, SenderLabel>();
  if (ids.length > 0) {
    const { rows: numbers } = await db.query<{ id: string; session_name: string; label: string | null; phone: string | null }>(
      `SELECT id, session_name, label, phone FROM ipy_wa_number WHERE id = ANY($1::uuid[])`, [ids],
    );
    for (const n of numbers) {
      known.set(n.id, { numberId: n.id, numberName: n.label?.trim() || n.session_name, numberPhone: maskPhone(n.phone) });
    }
  }
  return rows.map((row) => {
    const provider = typeof row.provider === 'string' ? row.provider : null;
    let label: SenderLabel = { numberId: null, numberName: null, numberPhone: null };
    if (provider && provider !== CHAT_PROVIDER) label = apiLabel(provider);
    else if (typeof row.number_id === 'string') label = known.get(row.number_id) ?? label;
    const { number_id: _gone, ...rest } = row;
    return { ...rest, ...label } as T & SenderLabel;
  });
}
