import { describe, expect, it } from 'vitest';
import { mobileIdentity } from '../src/core/entity/mobileIdentity.js';

describe('mobile identity normalisation', () => {
  it('matches Indian presentation variants without editing stored values', () => {
    for (const number of ['9822013456', '+91 98220 13456', '919822013456',
      '09822013456', '00919822013456', '(+91)-98220-13456']) {
      expect(mobileIdentity(number)).toBe('9822013456');
    }
  });
  it('does not collapse foreign country codes or missing digits', () => {
    expect(mobileIdentity('+44 7700 900123')).toBe('447700900123');
    expect(mobileIdentity('982201345')).toBe('982201345');
    expect(mobileIdentity('9822013456')).not.toBe(mobileIdentity('+44 9822013456'));
  });
  it('ignores empty fields', () => {
    for (const value of [null, undefined, '', ' ', '—']) expect(mobileIdentity(value)).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { REAL_ESTATE } from '../src/db/seed/templates/realEstate.js';

describe('one mobile number, one record across Leads, Inventory and Associates', () => {
  it('puts all three modules in the same shared-number group on a fresh install', () => {
    const groups = ['leads', 'properties', 'associates'].map(
      (name) => REAL_ESTATE.modules.find((m) => m.name === name)?.settings?.mobileIdentityGroup,
    );
    expect(groups[0]).toBeTruthy();
    expect(new Set(groups).size).toBe(1);
  });
  it('has a migration that brings the deployed Associates module into the same group', () => {
    const sql = readFileSync(new URL('../src/db/migrations/238_associates_shared_mobile_identity.sql', import.meta.url), 'utf8');
    expect(sql).toContain("name = 'associates'");
    expect(sql).toContain('crm-contact-mobile');
  });
});
