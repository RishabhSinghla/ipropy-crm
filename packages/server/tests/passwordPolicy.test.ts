import { describe, expect, it } from 'vitest';
import { strongPassword, whyPasswordIsWeak } from '../src/core/security/passwordPolicy.js';

describe('whyPasswordIsWeak', () => {
  it('refuses the password this repository publishes, however it is typed', () => {
    for (const guess of ['Admin@123', 'ADMIN@123', 'admin 123', 'Admin-1234', 'Admin@12345']) {
      expect(whyPasswordIsWeak(guess), guess).not.toBeNull();
    }
  });

  it('refuses short passwords, and says how long', () => {
    expect(whyPasswordIsWeak('Ab1cdefg')).toMatch(/at least 10/i);
  });

  it('wants upper case, lower case and a number', () => {
    expect(whyPasswordIsWeak('alllowercase123')).not.toBeNull();
    expect(whyPasswordIsWeak('ALLUPPERCASE123')).not.toBeNull();
    expect(whyPasswordIsWeak('NoNumbersAtAllHere')).not.toBeNull();
  });

  it('refuses a common choice that looks strong', () => {
    expect(whyPasswordIsWeak('Welcome@123')).not.toBeNull();
    expect(whyPasswordIsWeak('Password@1234')).not.toBeNull();
  });

  it('refuses a few characters repeated, and the e-mail address itself', () => {
    expect(whyPasswordIsWeak('Aaaaaaaaaaaa1')).not.toBeNull();
    expect(whyPasswordIsWeak('Priya.sharma2026X', 'priya.sharma@ipropy.com')).not.toBeNull();
  });

  it('accepts an ordinary good password', () => {
    expect(whyPasswordIsWeak('Mango-Tree-Lamp-42')).toBeNull();
    expect(whyPasswordIsWeak('kV7#pQ2wZx9L')).toBeNull();
  });

  it('works as a request-body schema and carries the reason', () => {
    const bad = strongPassword.safeParse('Admin@123');
    expect(bad.success).toBe(false);
    expect(strongPassword.safeParse('Mango-Tree-Lamp-42').success).toBe(true);
  });
});
