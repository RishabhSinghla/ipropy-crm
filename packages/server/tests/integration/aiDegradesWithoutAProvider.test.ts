/**
 * CLAUDE.md rule 7: AI must degrade gracefully.
 *
 * "Every AI feature pairs a deterministic rule engine with an optional LLM
 * pass. Never write AI code that throws or returns nothing when the key is
 * missing." No provider is configured in a test database, so this is the state
 * the rule is about — and it is also a real production state, because a free
 * key that runs out mid-month leaves the CRM exactly here.
 *
 * Matching, scoring, the digest, duplicate detection and the assistant all
 * carry on: their deterministic half is the substance and the model is a
 * flourish.
 *
 * **Drafting is the exception and this pins it as one.** It has no
 * deterministic half at all, so it stops outright — but it must say so
 * honestly: a 503 that names where to fix it, not a 400, which tells the
 * browser the rep typed something wrong. Giving it a template-based fallback
 * is a product decision, not a bug fix, and is deliberately not made here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

let app: ReturnType<typeof createApp>;
let token = '';
let leadId = '';
let propertyId = '';

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;

  const leads = await request(app).get('/api/records/leads?pageSize=1').set('Authorization', `Bearer ${token}`);
  leadId = leads.body.rows?.[0]?.id ?? '';
  const props = await request(app).get('/api/records/properties?pageSize=1').set('Authorization', `Bearer ${token}`);
  propertyId = props.body.rows?.[0]?.id ?? '';
});

describe('with no AI provider configured', () => {
  it('still matches, scores, and answers — the deterministic half carries it', async () => {
    const paths: [string, string][] = [
      ['get', `/api/ai/match/leads/${leadId}?narrative=false&limit=3`],
      ['get', `/api/ai/buyers-for/${propertyId}?limit=3&narrative=false`],
      ['get', `/api/ai/insights/${leadId}`],
      ['get', '/api/ai/digest'],
      ['get', '/api/ai/memory'],
      ['get', `/api/ai/records/leads/${leadId}/duplicates`],
    ];

    const broken: string[] = [];
    for (const [method, path] of paths) {
      const res = await (method === 'get'
        ? request(app).get(path)
        : request(app).post(path)).set('Authorization', `Bearer ${token}`);
      if (res.status >= 500 || res.status === 400) {
        broken.push(`${path} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
    }
    expect(broken, `These fell over without a model:\n${broken.join('\n')}`).toEqual([]);
  });

  it('scores a lead without one', async () => {
    const res = await request(app).post(`/api/ai/score-lead/${leadId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBeLessThan(400);
  });

  it('refuses to draft, honestly — 503 and where to fix it, not a 400', async () => {
    const res = await request(app).post('/api/ai/draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'whatsapp', module: 'leads', recordId: leadId });

    expect(res.status, 'a 400 says the rep typed something wrong; they did not').toBe(503);
    expect(res.body.message).toMatch(/Admin → Integrations/);
  });
});
