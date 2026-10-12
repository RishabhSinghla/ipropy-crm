/**
 * The messages a dealer posts, written into that dealer's notes.
 *
 * The four tabs on an Associate list their *properties*; the notes keep the
 * *conversation* — the message as it was written, in order, with when and where it
 * was said. One note per message however many groups it was forwarded into, written
 * once (`ipy_comment.market_post_id` is unique per record), and carrying the tabs its
 * listings fall under so a rep scrolling Notes can tell a sale from a requirement.
 *
 * Found by the dealer's number against the Associate's mobile and alternate phone, in
 * SQL through the same helpers every other phone match uses, so a field an admin
 * deleted reads as empty rather than raising.
 */
import { db } from '../../db/pool.js';
import { AUTOMATION_USER_ID } from '../auth/systemAccounts.js';
import { isAiAvailable } from '../../ai/client.js';
import { columnsOf, fieldText } from '../entity/payloadColumns.js';
import { identitySql } from '../entity/mobileIdentity.js';
import { registry } from '../metadata/registry.js';
import { tidyBody } from './readPost.js';

export const QUADRANT_LABELS = {
  forSale: 'For Sale',
  buyerRequirements: 'Buyer Requirements',
  forRent: 'For Rent',
  tenantRequirements: 'Tenant Requirements',
} as const;

type Quadrant = keyof typeof QUADRANT_LABELS;

export function quadrantOf(kind: string, purpose: string): Quadrant {
  if (kind === 'have') return purpose === 'rent' ? 'forRent' : 'forSale';
  return purpose === 'rent' ? 'tenantRequirements' : 'buyerRequirements';
}

/** "For Sale ×6 · For Rent ×2", in the order the tabs are in. Pure for its test. */
export function tabLine(listings: Array<{ kind: string; purpose: string }>): string {
  const counts = new Map<Quadrant, number>();
  for (const item of listings) counts.set(quadrantOf(item.kind, item.purpose), (counts.get(quadrantOf(item.kind, item.purpose)) ?? 0) + 1);
  return (Object.keys(QUADRANT_LABELS) as Quadrant[])
    .filter((quadrant) => counts.has(quadrant))
    .map((quadrant) => `${QUADRANT_LABELS[quadrant]}${counts.get(quadrant)! > 1 ? ` ×${counts.get(quadrant)}` : ''}`)
    .join(' · ');
}

export function noteFor(input: { groups: string[]; at: Date; body: string; listings: Array<{ kind: string; purpose: string }> }): string {
  const when = input.at.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  return `💬 WhatsApp · ${input.groups.join(' + ') || 'a dealer group'} · ${when}\n${tabLine(input.listings)}\n\n${tidyBody(input.body)}`;
}

/** Returns how many notes were written. Without an Associates module, or any Associate with a posted number, none. */
export async function syncDealerNotes(limit = 300): Promise<number> {
  const module = await registry.getModule('associates');
  if (!module || !module.isActive) return 0;
  const columns = await columnsOf('ipy_e_associates');
  const mobile = identitySql(fieldText(columns, 'a', 'mobile'));
  const alternate = identitySql(fieldText(columns, 'a', 'alternate_phone'));

  const rows = await db.query<{ post_id: string; record_id: string; body: string; groups: string[]; at: Date; listings: Array<{ kind: string; purpose: string }> }>(
    `SELECT p.id AS post_id, r.id AS record_id, p.body, p.groups, coalesce(p.first_posted_at, p.created_at) AS at,
            (SELECT jsonb_agg(jsonb_build_object('kind', l.kind, 'purpose', l.purpose) ORDER BY l.ord)
               FROM ipy_market_listing l WHERE l.post_id = p.id) AS listings
       FROM ipy_market_post p
       JOIN ipy_e_associates a ON (${mobile} = p.poster_phone OR ${alternate} = p.poster_phone)
       JOIN ipy_record r ON r.id = a.record_id AND r.is_deleted = false
      WHERE p.noted_at IS NULL AND NOT p.is_noise AND p.poster_phone IS NOT NULL
        AND EXISTS (SELECT 1 FROM ipy_market_listing l WHERE l.post_id = p.id)
        -- A long message waits for the AI model's read so its note carries the right tabs; it stops waiting if there is none.
        AND (NOT p.ai_pending OR NOT $1::boolean OR p.ai_attempts >= 2)
      ORDER BY at
      LIMIT $2`,
    [isAiAvailable(), limit],
  );

  const posts = new Set<string>();
  let written = 0;
  for (const row of rows.rows) {
    const inserted = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_comment (record_id, user_id, body, created_at, market_post_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (market_post_id, record_id) WHERE market_post_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [row.record_id, AUTOMATION_USER_ID, noteFor({ groups: row.groups, at: row.at, body: row.body, listings: row.listings ?? [] }), row.at, row.post_id],
    );
    if (inserted) written += 1;
    posts.add(row.post_id);
  }
  if (posts.size) await db.query(`UPDATE ipy_market_post SET noted_at = now() WHERE id = ANY($1::uuid[])`, [[...posts]]);
  return written;
}
