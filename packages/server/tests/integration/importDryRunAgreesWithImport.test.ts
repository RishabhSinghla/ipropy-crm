/**
 * A dry run that promises what the import refuses.
 *
 * The commit route checks the mapping before it writes a row: a mapping naming
 * a field that is no longer on the module is a saved template used after
 * somebody deleted or renamed that field, and it is refused by name rather
 * than left to fail per row.
 *
 * The dry run did not check. So the preview reported every row as "created,
 * no problems", the user pressed the button, and the import answered 400 on
 * the identical file and mapping. A preview that promises success and a button
 * that then refuses is worse than having no preview at all.
 *
 * Both halves are asserted here, because the bug is the *disagreement*: either
 * accepting a mapping the other rejects would be the same defect again.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

let app: ReturnType<typeof createApp>;
let token = '';

const FILE = Buffer.from(
  ['Full Name,Mobile', `QA Dry Run ${Date.now().toString(36)},9812345678`].join('\n'),
  'utf8',
);

beforeAll(async () => {
  app = createApp();
  const res = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = res.body.token;
});

describe('an import dry run', () => {
  it('refuses a mapping naming a field that is gone, exactly as the import does', async () => {
    // What a stale saved template looks like: the header maps to a field name
    // that no module has.
    const mapping = JSON.stringify({ 'Full Name': 'full_name', Mobile: 'a_field_nobody_has' });

    const dry = await request(app).post('/api/import/leads/dry-run')
      .set('Authorization', `Bearer ${token}`)
      .field('mapping', mapping)
      .attach('file', FILE, 'stale.csv');

    const live = await request(app).post('/api/import/leads')
      .set('Authorization', `Bearer ${token}`)
      .field('mapping', mapping)
      .attach('file', FILE, 'stale.csv');

    expect(dry.status, 'the dry run must not promise what the import refuses').toBe(400);
    expect(live.status).toBe(400);
    expect(dry.body.message).toContain('a_field_nobody_has');
    expect(dry.body.message).toBe(live.body.message);
  });

  it('still previews a mapping the import would accept', async () => {
    const mapping = JSON.stringify({ 'Full Name': 'full_name', Mobile: 'mobile' });
    const dry = await request(app).post('/api/import/leads/dry-run')
      .set('Authorization', `Bearer ${token}`)
      .field('mapping', mapping)
      .attach('file', FILE, 'good.csv');

    expect(dry.status).toBe(200);
    expect(dry.body.rows?.[0]?.outcome).toBeTruthy();
  });
});
