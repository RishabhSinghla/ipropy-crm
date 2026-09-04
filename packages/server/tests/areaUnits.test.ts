/**
 * 200 gaj and 1,800 sq.ft are the same size, and the matcher must agree.
 *
 * It did not. `matching.ts` read the buyer's `area_unit` and then never used it,
 * dividing the property's square feet by the buyer's number whatever unit that
 * number was in. For a plot buyer asking in gaj — which is how Faridabad quotes
 * plots — that made every listing look nine times too small.
 *
 * The quiet part is what a ratio of 9 does. It is neither a match nor "smaller
 * than asked for", so it falls into the branch that subtracts 3 points and says
 * nothing. The rep sees no area sentence at all, so there is nothing on screen
 * to notice is wrong; the unit that actually fits just quietly stops winning.
 *
 * The rename guard already described this field as needed "because a number
 * without its unit matches nothing correctly". It was right. Nothing read it.
 */
import { describe, expect, it } from 'vitest';
import { formatArea, toSqFt } from '@ipropy/shared';

describe('converting an area to square feet', () => {
  it('treats a gaj as nine square feet', () => {
    expect(toSqFt(200, 'sqyd')).toBe(1800);
    expect(toSqFt(200, 'gaj')).toBe(1800);
  });

  it('leaves square feet alone', () => {
    expect(toSqFt(1800, 'sqft')).toBe(1800);
  });

  it('reads a unit however somebody typed it', () => {
    /*
      The property's Area Unit is a free-text box, not the picklist the lead
      uses. "Sq. Yd." and "SQYD" are the same unit, and an unrecognised string
      falls back to square feet — which is silently the original bug again.
    */
    for (const written of ['Sq. Yd.', 'sq yd', 'SQYD', 'Sq.Yd']) {
      expect(toSqFt(200, written), `"${written}" should be read as square yards`).toBe(1800);
    }
  });

  it('assumes square feet when nothing was recorded', () => {
    // Most rows predate the unit being filled in, and square feet is what they
    // meant. Assuming anything else would rewrite history.
    expect(toSqFt(1800, null)).toBe(1800);
    expect(toSqFt(1800, undefined)).toBe(1800);
    expect(toSqFt(1800, '')).toBe(1800);
  });

  it('does not invent a conversion for a unit it does not know', () => {
    // Falling back to 1 is the honest failure: the number is used as written
    // rather than multiplied by a guess.
    expect(toSqFt(100, 'bigha')).toBe(100);
  });

  it('handles the other units the dropdown offers', () => {
    expect(Math.round(toSqFt(1, 'acre'))).toBe(43560);
    expect(Math.round(toSqFt(1, 'sqm'))).toBe(11);
  });
});

describe('the ratio the matcher actually computes', () => {
  /*
    The comparison itself, reproduced. A buyer asking for 200 gaj and the same
    buyer asking for 1,800 sq.ft must land in the same branch for the same unit,
    because they have asked for exactly the same thing.
  */
  const branch = (offered: number, offeredUnit: string, wanted: number, wantedUnit: string) => {
    const ratio = toSqFt(offered, offeredUnit) / toSqFt(wanted, wantedUnit);
    if (ratio >= 0.85 && ratio <= 1.15) return 'match';
    if (ratio < 0.85) return 'too small';
    return 'too big';
  };

  it('scores the same flat the same, whichever unit the buyer used', () => {
    const inGaj = branch(1850, 'sqft', 200, 'sqyd');
    const inSqFt = branch(1850, 'sqft', 1800, 'sqft');
    expect(inGaj).toBe(inSqFt);
    expect(inGaj).toBe('match');
  });

  it('no longer calls a well-fitting unit too big', () => {
    // The old behaviour: 1850 / 200 = 9.25, which read as far too big and
    // silently cost the best-fitting property 3 points.
    const oldRatio = 1850 / 200;
    expect(oldRatio).toBeGreaterThan(1.15);
    expect(branch(1850, 'sqft', 200, 'sqyd')).toBe('match');
  });

  it('still spots a genuinely small unit', () => {
    // Relaxing the comparison must not make everything a match. 100 gaj is
    // 900 sq.ft, which is genuinely too small for a 200 gaj buyer.
    expect(branch(900, 'sqft', 200, 'sqyd')).toBe('too small');
  });

  it('compares a plot quoted in gaj against a plot quoted in gaj', () => {
    expect(branch(210, 'sqyd', 200, 'sqyd')).toBe('match');
  });
});

describe('what the rep is shown', () => {
  it('quotes each side in the unit it was written in', () => {
    // A buyer who asked for 200 gaj should not read a converted number they
    // never typed. Their own figure is what they will recognise.
    expect(formatArea(200, 'sqyd')).toContain('sq.yd');
    expect(formatArea(1850, 'sqft')).toContain('sq.ft');
  });

  it('prints gaj as sq.yd, since that is what the dropdown says', () => {
    expect(formatArea(200, 'gaj')).toBe(formatArea(200, 'sqyd'));
  });

  it('falls back to square feet when no unit was recorded', () => {
    expect(formatArea(1850, null)).toContain('sq.ft');
  });
});
