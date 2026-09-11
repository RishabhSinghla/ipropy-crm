/**
 * What a connected assistant can reach.
 *
 * `/api/mcp` hands the CRM to Claude, ChatGPT or anything else that speaks MCP,
 * and the whole reason that is safe to point at real customer data is that it
 * goes through the CRM's own API carrying a personal key — so profile
 * permissions, sharing rules, field visibility, validation, workflows and the
 * audit trail all apply. Three limits sit on top of that, and nothing was
 * checking any of them:
 *
 *  * it starts read-only, and the write tools are not merely refused — they are
 *    not offered, so an assistant cannot even see them
 *  * `x-ipropy-write: allow` opts in, per connection
 *  * a key never deletes, and never reaches the admin area, even when it
 *    belongs to an administrator — which is exactly when that matters most
 *
 * A regression here does not look like a failure. It looks like an assistant
 * quietly being able to do more than it was meant to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: ReturnType<typeof createApp>;
const rawKey = `ipy_${crypto.randomBytes(24).toString('base64url')}`;
const KEY_NAME = 'qa mcp boundary';

const rpc = (body: unknown, write = false) => {
  const req = request(app).post('/api/mcp')
    .set('x-api-key', rawKey)
    .set('Accept', 'application/json, text/event-stream');
  if (write) req.set('x-ipropy-write', 'allow');
  return req.send(body as object);
};

const toolNames = (text: string): string[] =>
  [...new Set([...text.matchAll(/"name":"([a-z_.]+)"/g)].map((m) => m[1] as string))];

beforeAll(async () => {
  app = createApp();
  // Bound to an administrator on purpose: "the key belongs to an admin" is the
  // case the admin block exists for.
  await db.query(`DELETE FROM ipy_api_key WHERE name = $1`, [KEY_NAME]);
  await db.query(
    `INSERT INTO ipy_api_key (name, key_prefix, key_hash, user_id, scopes)
     SELECT $1, $2, $3, u.id, '[]'::jsonb FROM ipy_user u
      WHERE u.is_admin AND u.is_active ORDER BY u.created_at LIMIT 1`,
    [KEY_NAME, rawKey.slice(0, 8), bcrypt.hashSync(rawKey, 10)],
  );
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa', version: '1' } } });
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_api_key WHERE name = $1`, [KEY_NAME]).catch(() => undefined);
});

describe('a connected assistant', () => {
  it('needs a key — a signed-in session is not enough', async () => {
    const res = await request(app).post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('is offered no way to write until the connection asks', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(200);
    const names = toolNames(res.text);
    expect(names.length, 'no tools at all came back').toBeGreaterThan(0);
    for (const name of names) {
      expect(name, `${name} is offered on a read-only connection`).not.toMatch(/create|update|delete|add_note|remove/);
    }
  });

  it('gets exactly the writes it opted into, and never a delete', async () => {
    await rpc({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa', version: '1' } } }, true);
    const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, true);
    const names = toolNames(res.text);

    expect(names).toEqual(expect.arrayContaining(['create_lead', 'update_lead', 'add_note']));
    for (const name of names) {
      expect(name, 'a delete tool is being offered to an assistant').not.toMatch(/delete|remove|purge/);
    }
  });

  it('cannot administer the CRM or delete a record, even as an admin’s key', async () => {
    const admin = await request(app).get('/api/admin/users').set('x-api-key', rawKey);
    expect(admin.status).toBe(401);

    const gone = await request(app)
      .delete('/api/records/leads/00000000-0000-0000-0000-000000000000')
      .set('x-api-key', rawKey);
    expect(gone.status).toBe(401);
  });
});
