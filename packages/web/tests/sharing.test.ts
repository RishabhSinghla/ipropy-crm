/**
 * Which records may be sent outside the CRM.
 *
 * One rule, read by the web record page and by the app. It exists because the
 * web had `moduleName === 'properties'` written inline and the app was about
 * to get a second copy — and because the first attempt at reading the admin's
 * override read it off the wrong object entirely and silently fell back to the
 * default, which is a switch that appears to work and does nothing.
 */
import { describe, expect, it } from 'vitest';
import { canShareRecords } from '../src/lib/sharing';

describe('canShareRecords', () => {
  it('allows properties by default, because the public page renders one', () => {
    expect(canShareRecords('properties')).toBe(true);
  });

  /*
    `/s/:token` shows photos, a price and a floor plan. Pointed at a person it
    would show a buyer somebody's phone number and budget, so the default for
    anything else is no.
  */
  it('refuses every other module by default', () => {
    expect(canShareRecords('leads')).toBe(false);
    expect(canShareRecords('anything_custom')).toBe(false);
  });

  it('refuses when there is no module at all', () => {
    expect(canShareRecords(undefined)).toBe(false);
  });

  it('lets an admin switch it on for a module that is off by default', () => {
    expect(canShareRecords('leads', { shareable: true })).toBe(true);
  });

  it('lets an admin switch it off for one that is on by default', () => {
    expect(canShareRecords('properties', { shareable: false })).toBe(false);
  });

  /*
    The bug this pins. The override was read off an object that had no
    `settings` on it, so `configured` was always undefined and the rule always
    fell through to its default — on by default stayed on, off stayed off, and
    the admin's switch did nothing either way. Only an actual boolean may
    decide; anything else defers.
  */
  it('ignores a settings bag that does not mention it, rather than guessing', () => {
    expect(canShareRecords('properties', { duplicateCheckMode: 'all' })).toBe(true);
    expect(canShareRecords('leads', { duplicateCheckMode: 'all' })).toBe(false);
    expect(canShareRecords('leads', {})).toBe(false);
    expect(canShareRecords('leads', null)).toBe(false);
  });

  it('ignores a non-boolean, which is what a hand-edited settings bag produces', () => {
    expect(canShareRecords('leads', { shareable: 'true' })).toBe(false);
    expect(canShareRecords('properties', { shareable: 0 })).toBe(true);
  });
});
