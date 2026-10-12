/**
 * 12 October 2026, the owner, looking at the Chats screen: a template sent from the CRM showed as
 * "[template: ipropy_new_enquiry_details_mkt]" — a label, not the message the customer got.
 *
 * What is stored for a template is its approved wording with the blanks filled; and the messages
 * already sent are repaired by migration 209, run here against rows that look like production's.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { fillTemplateBody, templateWording } from '../../src/integrations/whatsapp/business/templates.js';

const stamp = Date.now();
const NAME = `wording_${stamp}`;
let conversationId = '';

beforeAll(async () => {
  await db.query(
    `INSERT INTO ipy_whatsapp_template (name, language, category, status, body_text)
     VALUES ($1, 'en', 'UTILITY', 'APPROVED', $2)`,
    [NAME, 'Hello {{1}}, thank you for asking about {{2}}. We will call you.'],
  );
  const conversation = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle) VALUES ('whatsapp', $1) RETURNING id`,
    [`wording${stamp}`],
  );
  conversationId = conversation!.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_message WHERE conversation_id = $1`, [conversationId]);
  await db.query(`DELETE FROM ipy_conversation WHERE id = $1`, [conversationId]);
  await db.query(`DELETE FROM ipy_whatsapp_template WHERE name = $1`, [NAME]);
});

describe('what a sent template says', () => {
  it('is the approved wording with each blank filled, and a missing value stays visible', () => {
    expect(fillTemplateBody('Hi {{1}}, re {{2}}', ['Riya', '3 BHK'])).toBe('Hi Riya, re 3 BHK');
    expect(fillTemplateBody('Hi {{1}}, re {{2}}', ['Riya'])).toBe('Hi Riya, re {{2}}');
    expect(fillTemplateBody('No blanks here', [])).toBe('No blanks here');
  });

  it('is read from the template the CRM holds, and falls back to the name only when it is not held', async () => {
    expect(await templateWording(NAME, 'en', ['Riya', 'Greenfields'])).toBe('Hello Riya, thank you for asking about Greenfields. We will call you.');
    expect(await templateWording(`nobody_${stamp}`, 'en', [])).toBe(`[template: nobody_${stamp}]`);
  });
});

describe('the messages already sent', () => {
  it('are repaired by the migration, blanks and all, and a message that is not a placeholder is left alone', async () => {
    const add = async (body: string, params: string[]) => (await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, provider, route, template_name, template_params)
       VALUES ($1, 'outbound', 'whatsapp', 'template', $2, 'delivered', 'test', 'business', $3, $4::jsonb) RETURNING id`,
      [conversationId, body, NAME, JSON.stringify(params)],
    ))!.id;
    const filled = await add(`[template: ${NAME}]`, ['Sonu', 'Greenfields Colony']);
    const plain = await add('A message a person typed', []);

    await db.query(readFileSync(new URL('../../src/db/migrations/209_template_messages_show_their_words.sql', import.meta.url), 'utf8'));

    const body = async (id: string) => (await db.queryOne<{ body: string }>(`SELECT body FROM ipy_message WHERE id = $1`, [id]))!.body;
    expect(await body(filled)).toBe('Hello Sonu, thank you for asking about Greenfields Colony. We will call you.');
    expect(await body(plain)).toBe('A message a person typed');
  });
});
