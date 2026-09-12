/**
 * One person's bad password must not lock out the room.
 *
 * The sign-in limiter was keyed on the IP alone, which is `express-rate-limit`'s
 * default, and this team shares an address — an office, or a mobile network's
 * NAT. Twenty failures against *one* account therefore locked out every
 * colleague behind it for fifteen minutes, correct password and all. It was
 * measured that way before this changed: a second account with the right
 * password got a 429.
 *
 * The bucket is per account *and* address now, so what matters is that two
 * people never share one — which is exactly what this checks. The spray guard
 * that still watches the address as a whole is verified by running it: 20
 * failures block the attacked account, a colleague still signs in, and 200
 * failures across distinct names block the address.
 */
import { describe, expect, it } from 'vitest';
import { attemptedAccount } from '../src/api/routes/auth.js';

describe('the sign-in bucket', () => {
  it('is different for two different people', () => {
    expect(attemptedAccount({ body: { identifier: 'aisha@ipropy.com' } }))
      .not.toBe(attemptedAccount({ body: { identifier: 'deepak@ipropy.com' } }));
  });

  it('is the same account however the name is typed', () => {
    const one = attemptedAccount({ body: { identifier: '  Aisha@iPropy.com ' } });
    const two = attemptedAccount({ body: { email: 'aisha@ipropy.com' } });
    expect(one).toBe(two);
  });

  it('is the same account however the phone is typed', () => {
    // The same reduction sign-in itself uses, so the bucket matches what is
    // actually under attack.
    const spaced = attemptedAccount({ body: { identifier: '+91 98765 43210' } });
    const trunk = attemptedAccount({ body: { identifier: '098765 43210' } });
    const bare = attemptedAccount({ body: { identifier: '9876543210' } });
    expect(spaced).toBe(bare);
    expect(trunk).toBe(bare);
  });

  it('does not collapse everyone into one bucket when the name is missing', () => {
    // An empty key would put every malformed attempt — and every attacker who
    // simply omits the field — into the same bucket as each other, which is
    // fine, but it must not be the bucket a real person lands in.
    const nobody = attemptedAccount({ body: {} });
    expect(nobody).not.toBe(attemptedAccount({ body: { identifier: 'aisha@ipropy.com' } }));
  });
});
