/**
 * What an ordinary agent reads in a contact's WhatsApp tab, against a real database. Roles are set the way production
 * has them (automatic = the official API, chat = OpenWA): a rep sees the chat and customer replies, a one-line stand-in
 * for an automatic message, and never which provider anything used. An administrator sees all of it.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { AUTOMATIC_MESSAGE_TEXT, channelRoles, setChannelRolesInMemory } from '../../src/integrations/whatsapp/business/channelRoles.js';
import { SEEDED, adminToken, contextFor, leadInput, signIn } from './fixtures.js';

const stamp = String(Date.now()).slice(-7);
const MOBILE = `94${stamp}1`.slice(0, 10);
let app: ReturnType<typeof createApp>;
let repToken = '';
let adminTok = '';
let leadId = '';
let conversationId = '';
const previousRoles = channelRoles();

beforeAll(async () => {
  app = createApp();
  repToken = await signIn(app, SEEDED.executiveA);
  adminTok = await adminToken(app);
  const lead = await recordService.createRecord(await contextFor(SEEDED.executiveA), 'leads', leadInput({ full_name: `AgentView ${stamp}`, mobile: MOBILE, country_code: '+91' }));
  leadId = lead.id;
  const convo = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, contact_name, record_id, record_module) VALUES ('whatsapp', $1, $2, $3, 'leads') RETURNING id`,
    [`+91${MOBILE}`, `AgentView ${stamp}`, leadId],
  );
  conversationId = convo!.id;
  for (const [direction, provider, body] of [
    ['inbound', 'whatsapp_openwa', 'customer says hello'],
    ['outbound', 'whatsapp_openwa', 'the rep typed this reply'],
    ['outbound', 'whatsapp_whatsmarketing', 'AUTOMATIC TEMPLATE WORDS SECRET'],
  ] as const) {
    await db.query(`INSERT INTO ipy_message (conversation_id, direction, channel, status, provider, route, body) VALUES ($1, $2, 'whatsapp', 'sent', $3, 'business', $4)`, [conversationId, direction, provider, body]);
  }
  setChannelRolesInMemory({ automation: 'whatsapp_whatsmarketing', chat: 'whatsapp_openwa' });
});

afterAll(async () => {
  setChannelRolesInMemory(previousRoles);
  await db.query(`DELETE FROM ipy_conversation WHERE id = $1`, [conversationId]);
  await db.query(`DELETE FROM ipy_record WHERE id = $1`, [leadId]);
});

const read = (token: string) => request(app).get(`/api/whatsapp-business/contacts/leads/${leadId}/messages`).set('Authorization', `Bearer ${token}`);

describe('a rep reading the contact\'s WhatsApp tab', () => {
  it('sees the chat and the customer, an automatic message only as a stand-in, and never a provider or route', async () => {
    const res = await read(repToken);
    expect(res.status).toBe(200);
    const bodies = res.body.messages.map((m: { body: string }) => m.body);
    expect(bodies).toContain('customer says hello');
    expect(bodies).toContain('the rep typed this reply');
    expect(bodies).toContain(AUTOMATIC_MESSAGE_TEXT);
    expect(JSON.stringify(res.body)).not.toContain('AUTOMATIC TEMPLATE WORDS SECRET');
    for (const m of res.body.messages) {
      expect(m).not.toHaveProperty('provider');
      expect(m).not.toHaveProperty('via');
    }
  });

  it('cannot read the official API\'s overview, whatever the screen shows', async () => {
    expect((await request(app).get('/api/whatsapp-business/overview').set('Authorization', `Bearer ${repToken}`)).status).toBe(403);
  });
});

describe('an administrator', () => {
  it('sees the real words and which route each message used', async () => {
    const res = await read(adminTok);
    const auto = res.body.messages.find((m: { body: string }) => m.body === 'AUTOMATIC TEMPLATE WORDS SECRET');
    expect(auto).toMatchObject({ automated: true, via: 'api' });
    const chat = res.body.messages.find((m: { body: string }) => m.body === 'the rep typed this reply');
    expect(chat.via).toBe('openwa');
  });
});
