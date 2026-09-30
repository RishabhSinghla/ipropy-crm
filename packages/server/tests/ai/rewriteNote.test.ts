import { describe, expect, it } from 'vitest';
import { tidyNote } from '../../src/ai/rewriteNote.js';

/*
  The floor under "Rewrite with AI" when no model is available: the note still
  comes back readable, in the words it was typed in — nothing translated,
  nothing invented.
*/
describe('tidyNote', () => {
  it('fixes spacing, capitals and the closing full stop', () => {
    expect(tidyNote('  client ko  3bhk pasand aaya .  budget 1.2 cr hai')).toBe('Client ko 3bhk pasand aaya. Budget 1.2 cr hai.');
  });
  it('capitalises a lone i and keeps the lines apart', () => {
    expect(tidyNote('i called them\n\n\n\nthey want a park facing unit')).toBe('I called them\n\nThey want a park facing unit.');
  });
  it('leaves a note that already ends properly alone', () => {
    expect(tidyNote('Site visit done!')).toBe('Site visit done!');
  });
});
