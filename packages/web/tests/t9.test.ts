/**
 * Finding somebody by typing their name on a number pad.
 *
 * Every rule here is one a rep would otherwise meet as "the dialler cannot
 * find people": a surname that is not the first word, a number stored with a
 * country code, a single key offering the whole database.
 */
import { describe, expect, it } from 'vitest';
import {
  digitsForName, digitsOnly, groupForDisplay, nameMatchesKeys, numberMatchesTyped, t9Matches,
} from '../src/lib/t9';

describe('spelling a name on the keys', () => {
  it('maps letters the way every phone has since 1963', () => {
    expect(digitsForName('abc')).toBe('222');
    expect(digitsForName('Pradeep')).toBe('7723337');
    expect(digitsForName('z')).toBe('9');
  });

  it('drops anything that is not a letter rather than inventing a key for it', () => {
    // A space is not a key. Mapping one would stop "Ravi Kumar" being findable
    // by the start of "Kumar".
    expect(digitsForName('Ravi Kumar')).toBe(digitsForName('RaviKumar'));
    expect(digitsForName("O'Brien-Smith")).toBe(digitsForName('OBrienSmith'));
    expect(digitsForName('राहुल')).toBe('');
  });

  it('matches the whole name or any word in it', () => {
    expect(nameMatchesKeys('Pradeep Gupta', '772')).toBe(true);   // Pra…
    expect(nameMatchesKeys('Pradeep Gupta', '4878')).toBe(true);  // Gupt…
    expect(nameMatchesKeys('Pradeep Gupta', '999')).toBe(false);
  });

  it('never matches on nothing typed', () => {
    expect(nameMatchesKeys('Pradeep Gupta', '')).toBe(false);
  });
});

describe('matching a number somebody is part way through typing', () => {
  it('ignores how the number happens to be stored', () => {
    for (const stored of ['+91 98102-34567', '09810234567', '919810234567']) {
      expect(numberMatchesTyped(stored, '98102'), stored).toBe(true);
    }
  });

  it('matches inside the number, not only at its start', () => {
    // A rep who remembers the last four digits is doing what a dialler is for,
    // and a stored +91 would fail every leading-digit test.
    expect(numberMatchesTyped('+919810234567', '4567')).toBe(true);
  });

  it('matches nothing on nothing', () => {
    expect(numberMatchesTyped('+919810234567', '')).toBe(false);
    expect(digitsOnly('+91 (98102) 34-567')).toBe('919810234567');
  });
});

describe('what the keypad offers', () => {
  const people = [
    { id: 'a', name: 'Pradeep Gupta', numbers: ['+919810234567'] },
    { id: 'b', name: 'Sanjeev Thakur', numbers: ['+919811533633'] },
    { id: 'c', name: 'Manjusa Benrjee', numbers: ['9898989898'] },
  ];

  it('offers nobody for a single key, because that is the whole database', () => {
    expect(t9Matches(people, '7')).toEqual([]);
  });

  it('puts a number match above a name match', () => {
    /*
      `72` spells "Pr…" (Pradeep) and "Sa…" (Sanjeev) — and it is also the
      start of nobody's number here, so both arrive as name matches. Typing
      `98102` is unambiguous and must not be buried under them.
    */
    const hits = t9Matches(people, '98102');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.record.name).toBe('Pradeep Gupta');
    expect(hits[0]!.how).toBe('number');
  });

  it('finds somebody by the keys for their name', () => {
    const hits = t9Matches(people, '726');  // "San…"
    expect(hits.map((h) => h.record.name)).toContain('Sanjeev Thakur');
    expect(hits[0]!.how).toBe('name');
  });

  it('counts a record once, never twice', () => {
    // "Manjusa" spells 626…, and 98 is the start of her number. One row either
    // way: a contact listed twice is a rep ringing the wrong one.
    const hits = t9Matches(people, '98');
    const ids = hits.map((h) => h.record.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the list short enough to read with a thumb', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: String(i), name: `Sandeep ${i}`, numbers: ['9800000000'],
    }));
    expect(t9Matches(many, '726').length).toBeLessThanOrEqual(5);
  });
});

describe('how the typed number reads back', () => {
  it('groups an Indian mobile five and five, which is how it is said aloud', () => {
    expect(groupForDisplay('+919810234567')).toBe('+91 98102 34567');
    expect(groupForDisplay('9810234567')).toBe('98102 34567');
  });

  it('shows a half-typed number as far as it has got', () => {
    expect(groupForDisplay('981')).toBe('981');
    expect(groupForDisplay('981023')).toBe('98102 3');
  });

  it('leaves alone anything that is not a ten-digit mobile', () => {
    // A landline, an extension or a number with a different country code is
    // none of this function's business — forcing a shape on it would be worse
    // than no shape at all.
    expect(groupForDisplay('+442071234567')).toBe('+442071234567');
    expect(groupForDisplay('*21#')).toBe('*21#');
  });
});
