/**
 * A secret that cannot be read says why, and does not take the server down.
 *
 * The keys derive from JWT_SECRET, so a secret saved under a different one is
 * unreadable — which is exactly what happens when a database is copied between
 * environments, and `db:pull-prod` exists to do that. It is a normal thing to
 * hit, not a corruption.
 *
 * What it looked like was five identical stack traces at boot saying
 * "Unsupported state or unable to authenticate data", which names neither the
 * cause nor the fix. The CRM then reported "the AI assistant needs an LLM
 * provider" while holding four provider keys it could not open, so the message
 * on screen and the reason in the log had nothing to do with each other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSecretBox } from '../src/core/secretbox.js';
import { config } from '../src/config.js';

/**
 * Encrypt, then change the secret, then read it back — which is precisely what
 * copying a database from another environment does to every stored credential.
 */
function sealedElsewhere(plain: string, salt = 'test-salt'): string {
  const original = config.auth.jwtSecret;
  config.auth.jwtSecret = 'the-secret-of-another-environment';
  const sealed = makeSecretBox(salt).encrypt(plain);
  config.auth.jwtSecret = original;
  return sealed;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a secret encrypted under a different key', () => {
  it('comes back empty rather than throwing', () => {
    // Returning empty is what lets the CRM start at all. A throw here happens
    // during warmup, before anything is listening.
    const sealed = sealedElsewhere('sk-live-something');
    expect(makeSecretBox('test-salt').decrypt(sealed)).toBe('');
  });

  it('says what happened and where to fix it', async () => {
    const { logger } = await import('../src/utils/logger.js');
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    makeSecretBox('test-salt').decrypt(sealedElsewhere('sk-live-something'));

    const message = String(spy.mock.calls.at(-1)?.[1] ?? '');
    expect(message, 'the cause a reader cannot guess').toContain('JWT_SECRET');
    expect(message, 'and somewhere to go').toContain('Admin');
    expect(message, 'it is unreadable here, not destroyed').toMatch(/not lost|unreadable/i);
  });

  it('round-trips a secret under its own key', () => {
    const box = makeSecretBox('test-salt');
    expect(box.decrypt(box.encrypt('sk-live-something'))).toBe('sk-live-something');
  });

  it('leaves a value that was never encrypted alone', () => {
    // Rows predating encryption are read as-is and re-encrypted on next save.
    const box = makeSecretBox('test-salt');
    expect(box.decrypt('plain-text-from-before')).toBe('plain-text-from-before');
  });

  it('treats an empty secret as empty, not as a failure', () => {
    const box = makeSecretBox('test-salt');
    expect(box.decrypt('')).toBe('');
    expect(box.decrypt(null)).toBe('');
    expect(box.decrypt(undefined)).toBe('');
  });
});
