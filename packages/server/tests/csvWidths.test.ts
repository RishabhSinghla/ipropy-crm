/**
 * A line with more values than the heading row.
 *
 * The row objects are keyed by heading, so the extras are dropped and — much
 * worse — every value after the offending cell shifts one column left. A
 * budget typed as ₹75,00,000 without quotes lands "000" in the locality, and
 * the file imports looking perfectly healthy.
 */
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/utils/csv.js';

describe('reading a CSV', () => {
  it('reports how many values each line really had', () => {
    const { headers, widths } = parseCsv(
      'Name,Budget,Locality\n'
      + 'Fine,5000000,Neharpar\n'
      + 'Broken,₹75,00,000,Neharpar\n',
    );
    expect(headers).toHaveLength(3);
    expect(widths).toEqual([3, 5]);
  });

  it('counts a trailing empty cell, because that is the case that hides', () => {
    // `Ballabgarh, Sector 64` unquoted, with a genuinely empty last column.
    // Trimming the blank first leaves the row looking aligned when nothing
    // after the comma is in the right column.
    const { widths } = parseCsv('Name,Locality,Owner\nX,Ballabgarh, Sector 64,\n');
    expect(widths).toEqual([4]);
  });

  it('still reads a quoted comma as one value', () => {
    const { rows, widths } = parseCsv('Name,Locality\nX,"Ballabgarh, Sector 64"\n');
    expect(rows[0].Locality).toBe('Ballabgarh, Sector 64');
    expect(widths).toEqual([2]);
  });
});
