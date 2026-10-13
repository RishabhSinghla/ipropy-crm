import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

const MARK = `prjw${Date.now()}`;
let app: ReturnType<typeof createApp>;
let admin: string;
let projectId: string | undefined;

beforeAll(async () => {
  app = createApp();
  admin = await signIn(app, 'admin@ipropy.com');
});

afterAll(async () => {
  if (projectId) await db.query(`DELETE FROM ipy_record WHERE id=$1`, [projectId]);
});

describe('isolated Project workspace data', () => {
  it('has its own configurable dropdown masters', async () => {
    const res = await request(app).get('/api/project-workspace/masters').set('Authorization', `Bearer ${admin}`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.category.map((item: { label: string }) => item.label)).toContain('Residential');
    expect(res.body.area_unit.map((item: { label: string }) => item.label)).toContain('Sq. Yds.');
  });

  it('stores project profile details and audit history separately from CRM fields', async () => {
    const created = await request(app)
      .post('/api/records/projects')
      .set('Authorization', `Bearer ${admin}`)
      .send({ project_name: `${MARK} Project`, project_status: 'New Launch', city: 'Faridabad' });
    expect(created.status, created.text).toBe(201);
    projectId = created.body.id;

    const saved = await request(app)
      .put(`/api/project-workspace/${projectId}/profile`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        developer: 'iPROPY Test Builder', category: 'residential', projectType: 'apartments',
        projectStatus: 'under_construction', city: 'Faridabad', locality: 'Sector 88',
        totalLandArea: 4.5, areaUnit: 'acre', towerCount: 3, unitCount: 280,
        startingPrice: 12500000, amenities: ['Clubhouse', 'Park'], lifecycle: 'draft',
      });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.profile).toMatchObject({ developer: 'iPROPY Test Builder', locality: 'Sector 88', towerCount: 3, unitCount: 280 });

    const read = await request(app).get(`/api/project-workspace/${projectId}/profile`).set('Authorization', `Bearer ${admin}`);
    expect(read.status, read.text).toBe(200);
    expect(read.body.profile.amenities).toEqual(['Clubhouse', 'Park']);

    const audit = await request(app).get(`/api/project-workspace/${projectId}/audit`).set('Authorization', `Bearer ${admin}`);
    expect(audit.status, audit.text).toBe(200);
    expect(audit.body).toHaveLength(1);
    expect(audit.body[0].action).toBe('profile_updated');
  });

  it('refuses to mutate a shared CRM dropdown through Project masters', async () => {
    const res = await request(app)
      .put('/api/project-workspace/masters/not-a-project-master')
      .set('Authorization', `Bearer ${admin}`)
      .send({ values: ['Unexpected'] });
    expect(res.status).toBe(404);
  });
});
