/** Minimal, correct CSV encode/decode — no dependency needed for this. */

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return columns?.length ? `${columns.map(escapeCell).join(',')}\n` : '';
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(row[c])).join(','));
  }
  // Excel needs the BOM to read UTF-8 (₹, names with diacritics) correctly.
  // eslint-disable-next-line no-irregular-whitespace -- the BOM is the feature
  return `﻿${lines.join('\n')}\n`;
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (Array.isArray(value)) s = value.join('; ');
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);

  // Neutralise formula injection — a leading =, +, -, @ is executed by Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;

  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function parseCsv(text: string): {
  headers: string[];
  rows: Record<string, string>[];
  /**
   * How many values each row actually had.
   *
   * The row objects are keyed by heading, so a line with more values than
   * headings silently loses the extras *and* shifts everything after the
   * offending cell — a budget lands in the locality column and the file
   * imports looking fine. That happens whenever somebody hand-edits a CSV and
   * leaves a comma inside a value unquoted, which is often. Kept here so the
   * importer can say so.
   */
  widths: number[];
} {
  // eslint-disable-next-line no-irregular-whitespace -- matching the BOM we wrote
  const clean = text.replace(/^﻿/, '');
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); records.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); records.push(row); }

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [], widths: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const body = nonEmpty.slice(1);
  const rows = body.map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])),
  );
  /*
    Counted whole, including a trailing empty cell.

    Trimming trailing blanks first looks reasonable and hides the exact case
    worth catching: `Ballabgarh, Sector 64` unquoted makes an eight-value line
    whose last value — the real trailing empty — trims away, leaving seven and
    a row that reads as perfectly aligned while every value after the comma
    sits one column to the left.
  */
  const widths = body.map((r) => r.length);
  return { headers, rows, widths };
}
