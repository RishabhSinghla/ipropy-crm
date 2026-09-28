/**
 * The Truecaller round trip, against a real database.
 *
 * The guard that hides everything behind it here is "nobody has switched the
 * card on" — every other test would stop at that refusal and prove nothing. So
 * this suite switches it on, which is the only way the nonce, the endpoint
 * check and the profile fetch ever execute. That lesson is already written
 * down in CLAUDE.md; this is it applied.
 *
 * `fetch` is stubbed for exactly one thing: Truecaller's profile endpoint. The
 * host check runs for real against the real hostname, so the line that keeps
 * the access token safe is the shipped one, not a test double.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/pool.js';
import { invalidate as reloadIntegrations } from '../../src/core/settings/integrations.js';
import {
  acceptTruecallerCallback,
  readTruecallerResult,
  startTruecallerVerification,
  truecallerIsSwitchedOn,
} from '../../src/integrations/leadsources/truecaller.js';

const TRUECALLER_PROFILE_URL = 'https://profile4-noneu.truecaller.com/v1/default';

async function switchTheCardOn(): Promise<void> {
  // `provider` carries no unique index, so this is a look-then-write rather
  // than an upsert — the same shape the WhatsApp send suite uses.
  const config = '{"appKey":"test-app-key","partnerName":"iPropy Test"}';
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_integration WHERE provider = 'truecaller'`,
  );
  if (existing) {
    await db.query(
      `UPDATE ipy_integration SET is_active = true, config = $2::jsonb WHERE id = $1`,
      [existing.id, config],
    );
  } else {
    await db.query(
      `INSERT INTO ipy_integration (provider, kind, label, is_active, config, credentials)
       VALUES ('truecaller', 'lead_source', 'Truecaller Number Verification', true, $1::jsonb, '{}'::jsonb)`,
      [config],
    );
  }
  await reloadIntegrations();
}

beforeAll(async () => {
  await switchTheCardOn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = 'truecaller'`);
  await db.query(`DELETE FROM ipy_truecaller_request`);
  await reloadIntegrations();
});

/** Answers the profile, and records whether it was asked at all. */
function stubTruecallerProfile(profile: unknown): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(profile), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

describe('starting a verification', () => {
  it('hands back a nonce and a link carrying the app key', async () => {
    const started = await startTruecallerVerification();
    expect(started).not.toBeNull();
    expect(started!.nonce.length).toBeGreaterThanOrEqual(8);
    expect(started!.deepLink).toContain('truecallersdk://truesdk/web_verify');
    expect(started!.deepLink).toContain('partnerKey=test-app-key');
    expect(started!.deepLink).toContain(`requestNonce=${started!.nonce}`);
  });

  it('is off entirely when nobody has switched the card on', async () => {
    await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = 'truecaller'`);
    await reloadIntegrations();

    expect(truecallerIsSwitchedOn()).toBe(false);
    expect(await startTruecallerVerification()).toBeNull();

    await switchTheCardOn();
  });
});

describe('the callback, which carries no signature of its own', () => {
  it('turns a real one into a verified name and number', async () => {
    const started = await startTruecallerVerification();
    const { calls } = stubTruecallerProfile({
      name: { first: 'Riya', last: 'Sharma' },
      phoneNumbers: [919812345678],
    });

    await acceptTruecallerCallback({
      requestId: started!.nonce,
      accessToken: 'a-token-only-truecaller-could-issue',
      endpoint: TRUECALLER_PROFILE_URL,
    });

    expect(calls).toEqual([TRUECALLER_PROFILE_URL]);
    expect(await readTruecallerResult(started!.nonce))
      .toEqual({ status: 'verified', name: 'Riya Sharma', phone: '919812345678' });
  });

  it('ignores a verification nobody started here', async () => {
    const { calls } = stubTruecallerProfile({ name: 'Nobody' });

    await acceptTruecallerCallback({
      requestId: 'a-nonce-this-crm-never-minted',
      accessToken: 'stolen',
      endpoint: TRUECALLER_PROFILE_URL,
    });

    // The token is never spent on an announcement we were not waiting for.
    expect(calls).toEqual([]);
    expect(await readTruecallerResult('a-nonce-this-crm-never-minted'))
      .toEqual({ status: 'unknown', name: null, phone: null });
  });

  it('never hands the token to an endpoint that is not Truecaller', async () => {
    const started = await startTruecallerVerification();
    const { calls } = stubTruecallerProfile({ name: 'Attacker' });

    await acceptTruecallerCallback({
      requestId: started!.nonce,
      accessToken: 'a-token-worth-stealing',
      endpoint: 'https://evil.example.com/v1/default',
    });

    expect(calls).toEqual([]);

    const result = await readTruecallerResult(started!.nonce);
    expect(result.status).toBe('failed');
    expect(result.name).toBeNull();

    // And the reason is a fact somebody can read, not a silent drop.
    const row = await db.queryOne<{ error: string }>(
      `SELECT error FROM ipy_truecaller_request WHERE nonce = $1`, [started!.nonce],
    );
    expect(row?.error).toMatch(/not Truecaller/i);
  });

  it('cannot be replayed once it has been used', async () => {
    const started = await startTruecallerVerification();
    stubTruecallerProfile({ name: { first: 'Riya' }, phoneNumbers: [919812345678] });
    await acceptTruecallerCallback({
      requestId: started!.nonce, accessToken: 't', endpoint: TRUECALLER_PROFILE_URL,
    });

    // A second delivery finds the row no longer pending and spends nothing.
    const { calls } = stubTruecallerProfile({ name: { first: 'Somebody Else' } });
    await acceptTruecallerCallback({
      requestId: started!.nonce, accessToken: 't', endpoint: TRUECALLER_PROFILE_URL,
    });

    expect(calls).toEqual([]);
    expect((await readTruecallerResult(started!.nonce)).name).toBe('Riya');
  });

  it('shrugs off a delivery that is not the shape it expects', async () => {
    await expect(acceptTruecallerCallback({ nothing: 'useful' })).resolves.toBeUndefined();
    await expect(acceptTruecallerCallback(null)).resolves.toBeUndefined();
  });
});

describe('what the waiting browser is told', () => {
  it('says pending until the callback lands, and never more than it should', async () => {
    const started = await startTruecallerVerification();
    expect(await readTruecallerResult(started!.nonce))
      .toEqual({ status: 'pending', name: null, phone: null });
  });
});
