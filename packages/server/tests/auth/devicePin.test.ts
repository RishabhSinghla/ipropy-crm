import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { pinDeviceToken, pinDeviceTokenHash, pinIsTooCommon } from '../../src/core/auth/devicePin.js';

describe('trusted-device PIN helpers', () => {
  it('extracts only the exact device cookie', () => {
    const req = {
      headers: { cookie: 'theme=dark; ipropy_pin_device=secret-token_123; other=value' },
    } as Request;
    expect(pinDeviceToken(req)).toBe('secret-token_123');
    expect(pinDeviceToken({ headers: { cookie: 'not_ipropy_pin_device=nope' } } as Request)).toBeNull();
  });

  it('stores a one-way token fingerprint, not the browser token', () => {
    const raw = 'browser-only-random-token';
    const hash = pinDeviceTokenHash(raw);
    expect(hash).not.toBe(raw);
    expect(hash).toBe(pinDeviceTokenHash(raw));
    expect(hash).toHaveLength(43);
  });

  it('rejects invalid and commonly guessed PINs without rejecting arbitrary digits', () => {
    for (const pin of ['123', 'abcd', '0000', '1111', '1234', '4321', '2580', '1212']) {
      expect(pinIsTooCommon(pin), pin).toBe(true);
    }
    expect(pinIsTooCommon('4827')).toBe(false);
  });
});
