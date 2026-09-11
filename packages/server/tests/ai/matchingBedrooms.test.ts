import { describe, expect, it } from 'vitest';
import { bhkNumber, parsedBedrooms } from '../../src/ai/matching.js';

/*
  The bedroom rule is the largest single term in a match score (±20) and it had
  never once fired on real inventory: the property field is a picklist whose
  options are "2 BHK", "3 BHK", "4+ BHK", "1 RK", and the reader was
  `Number(raw)` — NaN for every one of them, so every unit scored as though its
  bedroom count were unknown. Both ends of the comparison read the same
  vocabulary now, and this is what says so.
*/
describe('bedroom counts read the same vocabulary on both sides', () => {
  it('reads the picklist labels the inventory actually stores', () => {
    expect(parsedBedrooms({ matched_bedrooms_raw: '3 BHK' })).toBe(3);
    expect(parsedBedrooms({ matched_bedrooms_raw: '2.5 BHK' })).toBe(2.5);
    expect(parsedBedrooms({ matched_bedrooms_raw: '4+ BHK' })).toBe(4);
    expect(parsedBedrooms({ matched_bedrooms_raw: '1 RK' })).toBe(1);
    expect(parsedBedrooms({ matched_bedrooms_raw: ' 3 bhk ' })).toBe(3);
  });

  it('still reads a plain number, for a CRM whose bedroom field is numeric', () => {
    expect(parsedBedrooms({ matched_bedrooms_raw: '3' })).toBe(3);
  });

  it('answers null rather than NaN for anything that is not a count', () => {
    expect(parsedBedrooms({ matched_bedrooms_raw: null })).toBeNull();
    expect(parsedBedrooms({ matched_bedrooms_raw: '' })).toBeNull();
    expect(parsedBedrooms({ matched_bedrooms_raw: 'Duplex' })).toBeNull();
    expect(parsedBedrooms({ matched_bedrooms_raw: 'Plot' })).toBeNull();
  });

  it('agrees with the parser the buyer requirement uses', () => {
    for (const label of ['1 RK', '1 BHK', '2 BHK', '3.5 BHK', '5 BHK']) {
      expect(parsedBedrooms({ matched_bedrooms_raw: label })).toBe(bhkNumber(label));
    }
  });
});
