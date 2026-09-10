/**
 * Universal metadata-driven exporter.
 *
 * This module deliberately knows nothing about Contacts or Properties. It
 * receives module metadata plus permission-scoped record rows and produces a
 * CSV or workbook. Templates persist Field IDs, so changing a field label or
 * API name cannot turn a saved "Property Inventory" export blank.
 */
import ExcelJS from 'exceljs';
import { type FieldMeta, type ModuleMeta } from '@ipropy/shared';
import { toCsv } from '../../utils/csv.js';

export type ExportFormat = 'csv' | 'xlsx';
export interface ExportColumn { fieldId: string; header?: string }
export interface ExportRow { values: Record<string, unknown>; display?: Record<string, string> }

export interface ResolvedExportColumn { field: FieldMeta; header: string }

export function resolveExportColumns(module: ModuleMeta, requested?: ExportColumn[]): ResolvedExportColumn[] {
  const candidates = module.fields.filter((f) => f.isActive && f.displayType !== 'hidden' && f.config.exportable !== false);
  if (!requested?.length) return candidates.map((field) => ({ field, header: field.label }));
  const byId = new Map(candidates.map((f) => [f.internalId, f]));
  const seen = new Set<string>();
  return requested.flatMap((column): ResolvedExportColumn[] => {
    const field = byId.get(column.fieldId);
    // A deleted/non-exportable field is skipped rather than exposing it just
    // because an old template remembers it.
    if (!field || seen.has(field.internalId)) return [];
    seen.add(field.internalId);
    return [{ field, header: column.header?.trim() || field.label }];
  });
}

function valueFor(column: ResolvedExportColumn, row: ExportRow): string | number | boolean | Date | null {
  const raw = row.values[column.field.name];
  if (raw === null || raw === undefined) return null;
  // Preserve phone numbers exactly; Excel otherwise turns Indian mobiles into
  // scientific notation or removes leading zeroes.
  if (column.field.uitype === 'phone') return String(raw);
  if (['integer', 'decimal', 'currency', 'percent', 'area', 'score'].includes(column.field.uitype)) {
    const number = Number(raw);
    return Number.isFinite(number) ? number : String(raw);
  }
  if (column.field.uitype === 'boolean') return Boolean(raw);
  if (Array.isArray(raw)) return raw.join(', ');
  return row.display?.[column.field.name] ?? String(raw);
}

export async function buildExport(
  format: ExportFormat,
  columns: ResolvedExportColumn[],
  rows: ExportRow[],
): Promise<{ content: Buffer; contentType: string; extension: ExportFormat }> {
  if (format === 'csv') {
    const records = rows.map((row) => Object.fromEntries(columns.map((c) => [c.header, valueFor(c, row) ?? ''])));
    return { content: Buffer.from(toCsv(records), 'utf8'), contentType: 'text/csv; charset=utf-8', extension: 'csv' };
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'iPROPY CRM';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Export', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.field.internalId, width: Math.min(48, Math.max(14, column.header.length + 3)) }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  for (const row of rows) {
    const values = Object.fromEntries(columns.map((c) => [c.field.internalId, valueFor(c, row)]));
    const added = sheet.addRow(values);
    columns.forEach((column, index) => {
      const cell = added.getCell(index + 1);
      if (column.field.uitype === 'phone') cell.numFmt = '@';
      if (column.field.uitype === 'currency') cell.numFmt = '[$₹-en-IN]#,##0.00';
      if (column.field.uitype === 'percent') cell.numFmt = '0.00%';
      if (column.field.uitype === 'date') cell.numFmt = 'dd-mmm-yyyy';
      if (column.field.uitype === 'datetime') cell.numFmt = 'dd-mmm-yyyy hh:mm';
    });
  }
  return {
    content: Buffer.from(await workbook.xlsx.writeBuffer()),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
  };
}
