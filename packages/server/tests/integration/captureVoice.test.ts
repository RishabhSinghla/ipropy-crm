/**
 * The voice note attached at the gate.
 *
 * The paths that matter most here are the ones where nothing is configured,
 * because that is this installation today: no speech-to-text key, no AI
 * provider. The audio must still be stored, the visit must still work, and
 * nothing may throw — the same graceful-degradation contract every other AI
 * feature in this codebase holds to.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { getDriver } from '../../src/core/storage/index.js';
import { processPendingVoiceNotes, parseTranscript } from '../../src/core/capture/voice.js';
import { SEEDED } from './fixtures.js';

let app: Express;
let token: string;
let otherToken: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'Admin@123' });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.body.token as string;
}

/** A visit to attach a note to. */
async function startVisit(): Promise<string> {
  const res = await request(app).post('/api/capture/sessions')
    .set('Authorization', `Bearer ${token}`)
    .send({ clientRef: randomUUID(), property: { module: 'properties', values: { name: `Voice ${randomUUID().slice(0, 6)}` } } })
    .expect(201);
  return res.body.session.id as string;
}

const attachVoice = (sessionId: string, t = token, body = Buffer.from('fake-audio-bytes'), name = 'note.m4a', type = 'audio/mp4') =>
  request(app).post(`/api/capture/sessions/${sessionId}/voice`)
    .set('Authorization', `Bearer ${t}`)
    .attach('audio', body, { filename: name, contentType: type });

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await login(admin!.email);
  otherToken = await login(SEEDED.executiveB);
});

describe('POST /api/capture/sessions/:id/voice', () => {
  it('stores the recording and queues it for transcription', async () => {
    const sessionId = await startVisit();
    const res = await attachVoice(sessionId).expect(201);

    expect(res.body.voiceNoteId).toBeTruthy();
    const row = await db.queryOne<{ voice_status: string; voice_note_id: string; voice_attempts: number }>(
      `SELECT voice_status, voice_note_id, voice_attempts FROM ipy_shoot_session WHERE id = $1`, [sessionId],
    );
    expect(row?.voice_status).toBe('pending');
    expect(row?.voice_note_id).toBe(res.body.voiceNoteId);
    expect(row?.voice_attempts).toBe(0);

    // The bytes are really in storage, not merely recorded as being there.
    const attachment = await db.queryOne<{ storage_key: string; category: string }>(
      `SELECT storage_key, category FROM ipy_attachment WHERE id = $1`, [res.body.voiceNoteId],
    );
    expect(attachment?.category).toBe('voice_note');
    const driver = await getDriver();
    expect(await driver.read(attachment!.storage_key)).not.toBeNull();
  });

  it('files the note under the property it belongs to', async () => {
    const sessionId = await startVisit();
    const res = await attachVoice(sessionId).expect(201);
    const attachment = await db.queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM ipy_attachment WHERE id = $1`, [res.body.voiceNoteId],
    );
    expect(attachment!.storage_key).toMatch(/^properties\//);
    expect(attachment!.storage_key).toContain('voice-note');
  });

  it('rejects something that is not a recording', async () => {
    const sessionId = await startVisit();
    await attachVoice(sessionId, token, Buffer.from('%PDF-1.4'), 'brochure.pdf', 'application/pdf').expect(400);
  });

  it('rejects a request with no file at all', async () => {
    const sessionId = await startVisit();
    await request(app).post(`/api/capture/sessions/${sessionId}/voice`)
      .set('Authorization', `Bearer ${token}`).expect(400);
  });

  it('will not let one user attach audio to another\'s visit', async () => {
    const sessionId = await startVisit();
    await attachVoice(sessionId, otherToken).expect(404);
  });

  it('needs authentication', async () => {
    const sessionId = await startVisit();
    await request(app).post(`/api/capture/sessions/${sessionId}/voice`)
      .attach('audio', Buffer.from('x'), { filename: 'n.m4a', contentType: 'audio/mp4' })
      .expect(401);
  });

  it('re-recording replaces the note and resets its attempts', async () => {
    const sessionId = await startVisit();
    const first = await attachVoice(sessionId).expect(201);
    await db.query(`UPDATE ipy_shoot_session SET voice_attempts = 2, voice_error = 'boom' WHERE id = $1`, [sessionId]);

    const second = await attachVoice(sessionId).expect(201);
    expect(second.body.voiceNoteId).not.toBe(first.body.voiceNoteId);

    const row = await db.queryOne<{ voice_attempts: number; voice_error: string | null; voice_status: string }>(
      `SELECT voice_attempts, voice_error, voice_status FROM ipy_shoot_session WHERE id = $1`, [sessionId],
    );
    expect(row?.voice_attempts).toBe(0);
    expect(row?.voice_error).toBeNull();
    expect(row?.voice_status).toBe('pending');

    // The superseded audio is deliberately kept — it is the only copy of
    // something somebody said once.
    const old = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_attachment WHERE id = $1`, [first.body.voiceNoteId]);
    expect(old).toBeTruthy();
  });
});

describe('with nothing configured — which is this install today', () => {
  it('does no work and reports none, rather than failing', async () => {
    const sessionId = await startVisit();
    await attachVoice(sessionId).expect(201);

    // No STT key: the note stays pending forever, which is correct. It is not
    // an error, and it must not burn attempts — the day a key is added, every
    // note recorded until then transcribes.
    const result = await processPendingVoiceNotes();
    expect(result).toEqual({ done: 0, failed: 0 });

    const row = await db.queryOne<{ voice_status: string; voice_attempts: number }>(
      `SELECT voice_status, voice_attempts FROM ipy_shoot_session WHERE id = $1`, [sessionId],
    );
    expect(row?.voice_status).toBe('pending');
    expect(row?.voice_attempts).toBe(0);
  });

  it('parses nothing without an AI provider, and says so quietly', async () => {
    expect(await parseTranscript('B-110, 4 BHK, 3.25 crore', 'properties')).toBeNull();
  });

  it('never treats an empty transcript as work', async () => {
    expect(await parseTranscript('   ', 'properties')).toBeNull();
  });
});
