/**
 * Which accounts a go-live cleanup must not delete.
 *
 * The demo seed creates about a dozen users sharing a password published in this
 * repository, and every one is an open door into real customer data. Removing
 * them is the whole point of `go-live:users`.
 *
 * But one of those accounts is not a person. `system@ipropy` is the actor that
 * workflow tasks, telephony logging, lead capture and AI field writes all run
 * as, and each of those paths recreates it on demand — so deleting it does not
 * stop anything. It makes a second one, orphans everything the first owned, and
 * splits the audit trail, with nothing visible to show that it happened.
 *
 * The first run of that script listed `system@ipropy` for deletion. This is what
 * stops that coming back.
 */
import { describe, expect, it } from 'vitest';
import { isSystemAccount } from '../src/core/auth/systemAccounts.js';

describe('telling an automation account from a person', () => {
  it.each([
    'system@ipropy',
    'system@localhost',
    'automation@internal',
  ])('protects %s', (email) => {
    expect(isSystemAccount(email)).toBe(true);
  });

  it.each([
    'admin@ipropy.com',
    'priya.sharma@ipropy.com',
    'ipropy@gmail.com',
    'someone@sub.domain.co.in',
    'a.very.long.name@example.org',
  ])('treats %s as a person', (email) => {
    expect(isSystemAccount(email)).toBe(false);
  });

  it('is not fooled by whitespace or case', () => {
    expect(isSystemAccount('  SYSTEM@ipropy  ')).toBe(true);
    expect(isSystemAccount('  Admin@iPropy.COM  ')).toBe(false);
  });

  it('does not treat a dot before the @ as a domain dot', () => {
    // `first.last@intranet` is still an automation-shaped address: the dot that
    // matters is the one *after* the @.
    expect(isSystemAccount('first.last@intranet')).toBe(true);
  });
});
