/** Client-side CSV export for report results already loaded in memory. */
export function toCsvDownload(rows: Record<string, unknown>[], filename: string): void {
  if (!rows.length) return;

  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    let s = Array.isArray(value) ? value.join('; ') : String(value);
    // Neutralise formula injection in Excel.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    columns.map(escape).join(','),
    ...rows.map((row) => columns.map((c) => escape(row[c])).join(',')),
  ].join('\n');

  // BOM so Excel reads UTF-8 (₹ and Indian names) correctly.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
