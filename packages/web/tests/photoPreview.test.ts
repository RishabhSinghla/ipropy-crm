import { describe, expect, it } from 'vitest';
import { previewAfter, previewTries } from '../src/lib/photoPreview';

describe('photo preview fallback', () => {
  const tries = previewTries('/full', '/thumb');

  it('starts with the full picture', () => {
    expect(previewAfter(tries, 0)).toBe('/full');
  });

  it('falls back to the small picture the avatar shows', () => {
    expect(previewAfter(tries, 1)).toBe('/thumb');
  });

  it('gives up (null) rather than showing a broken image', () => {
    expect(previewAfter(tries, 2)).toBeNull();
  });

  it('does not try the same address twice', () => {
    expect(previewTries('/same', '/same')).toEqual(['/same']);
  });
});
