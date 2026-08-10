/**
 * The parts of provisioning that can be wrong without a database being present.
 *
 * The orchestration itself is proved by running it — a real database, real
 * migrations, a real seed — because a mocked `execFile` would only assert that
 * we call the thing we already know we call.
 */
import { describe, expect, it, vi } from 'vitest';
import { generatePassword, redactUrl } from '../../src/control/provision.js';
import { assertValidSlug } from '../../src/control/store.js';
import { createNeonProject } from '../../src/control/neon.js';

describe('redactUrl', () => {
  it('hides the password in a connection string', () => {
    expect(redactUrl('postgres://ipropy:s3cr3t@db.example.com:5432/acme'))
      .toBe('postgres://ipropy:***@db.example.com:5432/acme');
  });

  it('handles the query string Neon appends', () => {
    expect(redactUrl('postgresql://u:pw@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'))
      .toBe('postgresql://u:***@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require');
  });

  it('leaves a passwordless string alone', () => {
    expect(redactUrl('postgres://localhost:5432/acme')).toBe('postgres://localhost:5432/acme');
  });

  it('does not leak a password containing an @', () => {
    // A real hazard: pg accepts it, and a naive split on '@' would print it.
    expect(redactUrl('postgres://u:p@ss@host/db')).toBe('postgres://u:***@host/db');
  });
});

describe('generatePassword', () => {
  it('is long enough to be worth generating', () => {
    expect(generatePassword()).toHaveLength(24);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });
});

describe('assertValidSlug', () => {
  it.each(['acme', 'acme_realty', 'a1_2_3'])('accepts %s', (slug) => {
    expect(() => assertValidSlug(slug)).not.toThrow();
  });

  it.each([
    ['ab', 'too short to be a database name anyone can read'],
    ['1acme', 'starts with a digit, which Postgres will not take unquoted'],
    ['acme-realty', 'a dash needs quoting as an identifier, and one day someone will forget'],
    ['Acme', 'upper case folds unpredictably across Postgres and DNS'],
    ['acme realty', 'a space is not a database name'],
    ['droptable;--', 'not an identifier at all'],
  ])('rejects %s — %s', (slug) => {
    expect(() => assertValidSlug(slug)).toThrow(/not a usable slug/);
  });
});

describe('createNeonProject', () => {
  const ok = (body: unknown): Response => ({
    ok: true, status: 200, json: async () => body,
  } as Response);

  it('returns the pooled connection string and project id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({
      project: { id: 'proj-123' },
      connection_uris: [{ connection_uri: 'postgres://u:p@ep-x.neon.tech/neondb' }],
    }));

    await expect(createNeonProject({ apiKey: 'k', name: 'ipropy-acme', fetchImpl: fetchImpl as never }))
      .resolves.toEqual({ projectId: 'proj-123', connectionUri: 'postgres://u:p@ep-x.neon.tech/neondb' });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toMatchObject({
      project: { name: 'ipropy-acme', region_id: 'aws-ap-southeast-1' },
    });
  });

  it('throws rather than record a tenant with no connection string', async () => {
    // Neon answering 2xx without connection_uris has to be an error here: the
    // alternative is a customer row that looks provisioned and connects nowhere.
    const fetchImpl = vi.fn().mockResolvedValue(ok({ project: { id: 'proj-123' } }));
    await expect(createNeonProject({ apiKey: 'k', name: 'x', fetchImpl: fetchImpl as never }))
      .rejects.toThrow(/no connection string/);
  });

  it('surfaces the API error body, not just the status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 422, text: async () => '{"message":"project limit reached"}',
    } as Response);
    await expect(createNeonProject({ apiKey: 'k', name: 'x', fetchImpl: fetchImpl as never }))
      .rejects.toThrow(/project limit reached/);
  });
});
