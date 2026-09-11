import { describe, expect, it } from 'vitest';
import { hasDevanagari, toLatin } from '../../src/ai/devanagari.js';

/*
  The owner's rule for notes: English or Hinglish, always Latin script, never
  Devanagari. Whisper decides a code-mixed sentence is Hindi often enough that
  this has to hold with no model available at all, which is what this covers.
*/
describe('Devanagari notes are written the way the desk writes them', () => {
  it('leaves a note that is already Latin exactly as it is', () => {
    const note = 'Talked with client, site visit Sunday 11 am, budget 1.5 Cr.';
    expect(hasDevanagari(note)).toBe(false);
    expect(toLatin(note)).toBe(note);
  });

  it('transliterates rather than translates', () => {
    expect(toLatin('बात')).toBe('baat');
    expect(toLatin('काम')).toBe('kaam');
    expect(toLatin('क्लाइंट')).toBe('klaaint');
    expect(toLatin('साइट विजिट')).toBe('saait vijit');
  });

  it('keeps the English half of a Hinglish sentence untouched', () => {
    expect(toLatin('client से baat hui')).toBe('client se baat hui');
  });

  it('keeps numbers, and reads Devanagari digits as digits', () => {
    expect(toLatin('बजट 1.5 Cr')).toBe('bajat 1.5 Cr');
    expect(toLatin('३ BHK')).toBe('3 BHK');
  });

  it('ends a sentence with a full stop rather than a danda', () => {
    expect(toLatin('हाँ।')).toBe('haan.');
  });
});
