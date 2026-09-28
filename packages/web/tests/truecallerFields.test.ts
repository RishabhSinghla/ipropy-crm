/**
 * Which boxes a verified profile fills.
 *
 * Getting this wrong is silent — the visitor taps Verify, Truecaller says yes,
 * and the form sits there unchanged — so the matching is pure and pinned here
 * rather than being discovered on somebody's phone.
 */
import { describe, expect, it } from 'vitest';
import { nameFieldName, phoneFieldName } from '../src/lib/truecaller';

describe('finding the phone box on a form somebody else built', () => {
  it('reads the names real forms use', () => {
    expect(phoneFieldName([{ name: 'email' }, { name: 'mobile' }])).toBe('mobile');
    expect(phoneFieldName([{ name: 'phone' }])).toBe('phone');
    expect(phoneFieldName([{ name: 'contact_no' }])).toBe('contact_no');
    expect(phoneFieldName([{ name: 'whatsapp_number' }])).toBe('whatsapp_number');
  });

  it('answers null rather than filling the wrong box', () => {
    expect(phoneFieldName([{ name: 'email' }, { name: 'message' }])).toBeNull();
    expect(phoneFieldName([])).toBeNull();
  });
});

describe('finding the name box', () => {
  it('prefers the box a whole name belongs in', () => {
    expect(nameFieldName([{ name: 'last_name' }, { name: 'first_name' }])).toBe('first_name');
    expect(nameFieldName([{ name: 'last_name' }, { name: 'full_name' }])).toBe('full_name');
    expect(nameFieldName([{ name: 'name' }])).toBe('name');
  });

  it('falls back to whatever name box there is', () => {
    expect(nameFieldName([{ name: 'last_name' }])).toBe('last_name');
  });

  it('answers null on a form with no name box', () => {
    expect(nameFieldName([{ name: 'mobile' }, { name: 'message' }])).toBeNull();
  });

  it('does not mistake a project box for a name', () => {
    expect(nameFieldName([{ name: 'project' }, { name: 'mobile' }])).toBeNull();
  });
});
