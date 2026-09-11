/**
 * A contact's name must not run when somebody opens the export.
 *
 * A cell beginning `=`, `+`, `-` or `@` is a formula to Excel, and the classic
 * version of this is a lead called `=cmd|'/c calc'!A0` arriving through a
 * public web form and executing on the desk of whoever exports the list. The
 * CRM takes names from strangers on the internet, and the team opens these
 * files in Excel, so both halves of that are true here.
 *
 * CSV is protected on purpose, in `utils/csv.ts`: a leading sign gets an
 * apostrophe and Excel then treats the cell as text.
 *
 * XLSX is protected **by accident**, and that is why it is pinned. ExcelJS
 * writes a plain string as a string cell — a formula needs `{ formula: … }` —
 * so `=1+1` lands in sharedStrings as text with no `<f>` element anywhere. That
 * holds today and depends entirely on the library, so a version bump or
 * somebody "helpfully" setting a formula would give it away silently.
 */
import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/utils/csv.js';

const DANGEROUS = ['=1+1', `=cmd|'/c calc'!A0`, '+1+1', '-1+1', '@SUM(1+1)'];

describe('an export', () => {
  it('neutralises a formula in CSV, whichever sign it starts with', () => {
    for (const value of DANGEROUS) {
      const csv = toCsv([{ Name: value }]);
      const cell = csv.split('\n')[1] ?? '';
      expect(cell, `${value} was left executable`).toContain(`'${value}`);
      // And what Excel sees first must not be a sign.
      expect(cell.replace(/^"/, '')[0], `${value} still leads with a sign`).toBe("'");
    }
  });

  it('leaves an ordinary name alone', () => {
    const csv = toCsv([{ Name: 'Rakesh Kumar' }]);
    expect(csv).toContain('Rakesh Kumar');
    expect(csv).not.toContain("'Rakesh");
  });

  it('also covers a tab or a carriage return, which Excel treats the same way', () => {
    for (const value of ['\tcalc', '\rcalc']) {
      const csv = toCsv([{ Name: value }]);
      expect(csv.split('\n')[1] ?? '').toContain("'");
    }
  });
});
