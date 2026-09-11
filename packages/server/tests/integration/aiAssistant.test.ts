import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { contextFor, propertyInput, SEEDED } from './fixtures.js';

let app: Express;
let token: string;
let otherToken: string;
let userId: string;
let userEmail: string;

async function login(email: string): Promise<string> {
  const response = await request(app).post('/api/auth/login').send({ email, password: 'Admin@123' });
  if (response.status !== 200) throw new Error(`login failed: ${response.status} ${response.text}`);
  return response.body.token as string;
}

const authorised = (method: 'get' | 'post' | 'patch' | 'delete', path: string, authToken = token) =>
  request(app)[method](path).set('Authorization', `Bearer ${authToken}`);

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM ipy_user
     WHERE is_admin = true AND password_hash IS NOT NULL
     ORDER BY created_at LIMIT 1`,
  );
  if (!admin) throw new Error('Seed admin missing');
  userEmail = `ask-ipropy-${randomUUID()}@itest.ipropy`;
  const user = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_user (email, password_hash, first_name, last_name, is_admin)
     VALUES ($1,$2,'Ask','iPropy Test',true) RETURNING id`,
    [userEmail, admin.password_hash],
  );
  if (!user) throw new Error('Could not create isolated assistant user');
  userId = user.id;
  token = await login(userEmail);
  otherToken = await login(SEEDED.executiveB);
});

describe('Ask iPropy conversations, memory and confirmed actions', () => {
  it('creates a conversation automatically and stores explicit memory without an LLM call', async () => {
    const response = await authorised('post', '/api/ai/ask')
      .send({ question: 'Remember that I prefer property captions in Hinglish.' })
      .expect(200);

    expect(response.body.threadId).toMatch(/[0-9a-f-]{36}/);
    expect(response.body.answer).toContain('I’ll remember');
    expect(response.body.remembered.fact).toBe('I prefer property captions in Hinglish');

    const thread = await authorised('get', `/api/ai/threads/${response.body.threadId}`).expect(200);
    expect(thread.body.messages).toHaveLength(2);
    expect(thread.body.messages[0].role).toBe('user');

    const memory = await authorised('get', '/api/ai/memory').expect(200);
    expect(memory.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact: 'I prefer property captions in Hinglish' }),
    ]));
  });

  it('never lets another signed-in user read, continue or delete the conversation', async () => {
    const created = await authorised('post', '/api/ai/threads').send({ title: `Private ${randomUUID()}` }).expect(201);

    await authorised('get', `/api/ai/threads/${created.body.id}`, otherToken).expect(404);
    await authorised('post', '/api/ai/ask', otherToken)
      .send({ threadId: created.body.id, question: 'Show me this private chat' })
      .expect(404);
    await authorised('delete', `/api/ai/threads/${created.body.id}`, otherToken).expect(404);
  });

  it('executes the stored validated payload only after confirmation', async () => {
    const marker = `AI Action ${randomUUID()}`;
    const property = await recordService.createRecord(await contextFor(userEmail), 'properties', propertyInput({
      full_name: marker,
      status: 'Available',
    }));
    const thread = await authorised('post', '/api/ai/threads').send({ title: marker }).expect(201);
    const action = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_ai_action
         (user_id, thread_id, action_type, module_name, record_id, payload, preview)
       VALUES ($1,$2,'update_record','properties',$3,$4::jsonb,$5)
       RETURNING id`,
      [
        userId,
        thread.body.id,
        property.id,
        JSON.stringify({
          updates: { status: 'Not For Sale' },
          changes: [{ field: 'status', label: 'Status', from: 'Available', to: 'Not For Sale' }],
          recordLabel: marker,
        }),
        `Mark ${marker} unavailable`,
      ],
    );
    if (!action) throw new Error('Could not prepare test action');

    const before = await recordService.getRecord(await contextFor(userEmail), 'properties', property.id);
    expect(before.values.status).toBe('Available');

    await authorised('post', `/api/ai/actions/${action.id}/confirm`, otherToken).send({}).expect(404);
    const confirmed = await authorised('post', `/api/ai/actions/${action.id}/confirm`).send({}).expect(200);
    expect(confirmed.body.action.status).toBe('confirmed');

    const after = await recordService.getRecord(await contextFor(userEmail), 'properties', property.id);
    expect(after.values.status).toBe('Not For Sale');
    await authorised('post', `/api/ai/actions/${action.id}/confirm`).send({}).expect(400);
  });

  it('lets the owner delete a saved memory and a conversation', async () => {
    const saved = await authorised('post', '/api/ai/ask')
      .send({ question: `Remember that ${randomUUID()} is my test preference` })
      .expect(200);
    await authorised('delete', `/api/ai/memory/${saved.body.remembered.id}`).expect(200);
    await authorised('delete', `/api/ai/threads/${saved.body.threadId}`).expect(200);
    await authorised('get', `/api/ai/threads/${saved.body.threadId}`).expect(404);
  });
});
