/**
 * One door for "the file somebody uploaded", whatever kind it is.
 *
 * The importer should not know or care whether it was handed a CSV or a
 * workbook, and the two places that read an uploaded file (preview and the
 * run itself) must agree — they used to both call `parseCsv` directly, so
 * adding a format meant remembering both.
 */
import { parseCsv } from '../../utils/csv.js';
import { looksLikeXlsx, parseXlsx } from '../../utils/xlsx.js';
import { BadRequestError } from '../../utils/errors.js';

export interface Sheet {
  headers: string[];
  rows: Record<string, string>[];
}

export function readImportFile(buffer: Buffer, filename: string): Sheet {
  // The magic bytes decide, not the extension: a workbook renamed .csv is
  // still a workbook, and a CSV emailed as .xls is still text.
  if (looksLikeXlsx(buffer)) {
    try {
      return parseXlsx(buffer);
    } catch (err) {
      throw new BadRequestError(
        `Could not read “${filename}” as an Excel file: ${(err as Error).message} `
        + 'Saving it as CSV from Excel always works.',
      );
    }
  }

  // .xls is the old binary format — a different file altogether, and not one
  // worth writing a reader for. Say so plainly instead of handing back a sheet
  // of mojibake.
  if (/\.xls$/i.test(filename) && buffer.length > 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    throw new BadRequestError(
      `“${filename}” is the older .xls format. Open it in Excel and save as .xlsx or .csv.`,
    );
  }

  return parseCsv(buffer.toString('utf8'));
}
