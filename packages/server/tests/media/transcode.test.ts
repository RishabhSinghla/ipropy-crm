import { describe, expect, it } from 'vitest';
import { needsTranscode } from '../../src/core/media/transcode.js';

describe('HEIC derivative preparation', () => {
  it('recognises all normal iPhone HEIC/HEIF MIME forms', () => {
    for (const mime of [
      'image/heic', 'image/heif', 'image/HEIC',
      'image/heic-sequence', 'image/heif-sequence', ' image/heic ',
    ]) {
      expect(needsTranscode(mime), mime).toBe(true);
    }
  });

  it('leaves formats Sharp already decodes on the direct path', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/quicktime']) {
      expect(needsTranscode(mime), mime).toBe(false);
    }
  });

  it('does not match unrelated types that merely contain the word heic', () => {
    expect(needsTranscode('image/x-heicanthropus')).toBe(false);
    expect(needsTranscode('application/heic+json')).toBe(false);
  });
});
