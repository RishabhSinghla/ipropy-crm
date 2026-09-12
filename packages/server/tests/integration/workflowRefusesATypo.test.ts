/**
 * A workflow that cannot work should not save.
 *
 * `runTask` answers an unknown task type with a log line and a return, and the
 * engine only listens for the triggers it knows. Both fields were `z.string()`,
 * so a workflow built with a typo saved happily, appeared in the list looking
 * armed, ran green on every matching record and did nothing at all — with a run
 * log full of successes.
 *
 * `field_update` for `update_fields` is the obvious guess and the one that
 * caught this. Refused now, at the point somebody can still fix it, and the
 * message names what is allowed rather than only what is wrong.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
const made: string[] = [];

const workflow = (over: Record<string, unknown>) => ({
  module: 'leads',
  name: `QA WF ${Date.now().toString(36)}`,
  trigger: 'on_create',
  tasks: [{ type: 'update_fields', name: 'Set it', config: { values: {} } }],
  ...over,
});

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
});

describe('creating a workflow', () => {
  it('refuses a task type that has no handler, and says which exist', async () => {
    const res = await request(app).post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send(workflow({ tasks: [{ type: 'field_update', name: 'Typo', config: {} }] }));

    expect(res.status).toBe(422);
    expect(res.body.message).toContain('update_fields');
  });

  it('refuses a trigger nothing emits, and says which exist', async () => {
    const res = await request(app).post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send(workflow({ trigger: 'on_created' }));

    expect(res.status).toBe(422);
    expect(res.body.message).toContain('on_create');
  });

  it('still accepts one that can actually run', async () => {
    const res = await request(app).post('/api/workflows')
      .set('Authorization', `Bearer ${token}`)
      .send(workflow({}));

    expect(res.status).toBe(201);
    if (res.body?.id) made.push(res.body.id);

    for (const id of made) {
      await request(app).delete(`/api/workflows/${id}`).set('Authorization', `Bearer ${token}`);
    }
  });
});
