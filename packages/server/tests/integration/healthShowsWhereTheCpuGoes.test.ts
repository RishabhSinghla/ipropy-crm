/**
 * The health check can say what the server is busy with.
 *
 * 11 October 2026: the CRM was slow, the vitals said the CPU was saturated and
 * the event loop stalled for over a second, and nothing said *which code*.
 * `?profile=1` asks V8 for an eight-second sample. It must start on the first
 * ask, stay at rest rather than start a second, and return named functions —
 * with no request data in them.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /api/health?profile=1', () => {
  it('starts a sample, then reports the busiest functions', async () => {
    const app = createApp();

    const first = await request(app).get('/api/health?profile=1').expect(200);
    expect(first.body.cpuProfile.state).toBe('started');

    const during = await request(app).get('/api/health?profile=1').expect(200);
    expect(during.body.cpuProfile.state).toBe('sampling');

    // Give the sampler something to see.
    const busyUntil = Date.now() + 500;
    while (Date.now() < busyUntil) Math.sqrt(Math.random());

    await new Promise((resolve) => setTimeout(resolve, 8500));
    const after = await request(app).get('/api/health?profile=1').expect(200);
    expect(after.body.cpuProfile.state).toBe('ready');
    expect(after.body.cpuProfile.top.length).toBeGreaterThan(0);
    expect(after.body.cpuProfile.top[0]).toEqual(expect.objectContaining({ where: expect.any(String), ms: expect.any(Number) }));
  }, 30_000);

  it('adds nothing unless asked', async () => {
    const res = await request(createApp()).get('/api/health').expect(200);
    expect(res.body.cpuProfile).toBeUndefined();
    expect(res.body.vitals).toBeDefined();
  });
});
