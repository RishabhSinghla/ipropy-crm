/**
 * `ipy_api_key.scopes` had existed since the table did and nothing read it.
 *
 * Every key therefore carried its owner's whole access, which is what made one
 * published by accident — into this repository's public Actions log, on
 * 18 August 2026 — as bad as it was: read every contact and property, create
 * and update records. The n8n media pipeline that holds it makes exactly one
 * call with it, `POST /api/files`.
 *
 * Empty stays unrestricted on purpose. Every key written before this has `[]`,
 * and any other reading would have cut off every integration the moment it
 * shipped.
 */
import { describe, expect, it } from 'vitest';
import { __testing } from '../src/middleware/auth.js';

const { scopeAllows } = __testing;

describe('an API key with scopes', () => {
  it('is unrestricted when it has none, as every existing key does', () => {
    expect(scopeAllows([], 'DELETE', '/api/records/leads/abc')).toBe(true);
    expect(scopeAllows([], 'GET', '/api/anything')).toBe(true);
  });

  it('reaches only what it names, when it names a method', () => {
    const only = ['POST /api/files'];
    expect(scopeAllows(only, 'POST', '/api/files')).toBe(true);
    // The real shape the media pipeline posts to.
    expect(scopeAllows(only, 'POST', '/api/files/upload')).toBe(true);
    expect(scopeAllows(only, 'GET', '/api/files')).toBe(false);
    expect(scopeAllows(only, 'GET', '/api/records/leads')).toBe(false);
    expect(scopeAllows(only, 'POST', '/api/records/leads')).toBe(false);
  });

  it('allows any method when the scope names only a path', () => {
    const leads = ['/api/records/leads'];
    expect(scopeAllows(leads, 'GET', '/api/records/leads')).toBe(true);
    expect(scopeAllows(leads, 'PATCH', '/api/records/leads/abc')).toBe(true);
    expect(scopeAllows(leads, 'GET', '/api/records/properties')).toBe(false);
  });

  it('does not let a prefix leak into a neighbouring path', () => {
    // `/api/files` must not open `/api/files-admin`, which a bare
    // `startsWith` would have done.
    expect(scopeAllows(['POST /api/files'], 'POST', '/api/files-admin')).toBe(false);
    expect(scopeAllows(['/api/records/leads'], 'GET', '/api/records/leads-export')).toBe(false);
  });

  it('ignores blank entries rather than treating them as a wildcard', () => {
    expect(scopeAllows(['', '   '], 'GET', '/api/records/leads')).toBe(false);
  });

  it('matches the method case-insensitively, since a client may shout it', () => {
    expect(scopeAllows(['post /api/files'], 'POST', '/api/files')).toBe(true);
  });
});
