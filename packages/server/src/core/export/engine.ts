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

/*
  An amount and its unit travel together.

  `budget` and `area` each carry a companion picklist — `budget_unit`,
  `area_unit` — holding whether the number is a total or per sq. ft. Those
  companions are `display_type: hidden`, because the form shows one combined
  control rather than two boxes, so a plain export dropped them and wrote
  ₹26,000,000 in a column that might have meant per square yard. A spreadsheet
  is exactly where nobody can ask.

  So a field that names a `unitField` gets its unit in the next column. That is
  the "separate columns" half of the brief (`Demand | Demand Unit`); the number
  stays a real number so Excel can still sum and sort it.
*/
function withUnitCompanion(module: ModuleMeta, column: ResolvedExportColumn): ResolvedExportColumn[] {
  const unitName = typeof column.field.config.unitField === 'string' ? column.field.config.unitField : null;
  if (!unitName) return [column];
  const unit = module.fields.find((f) => f.name === unitName && f.isActive);
  if (!unit) return [column];
  return [column, { field: unit, header: `${column.header} Unit` }];
}

export function resolveExportColumns(module: ModuleMeta, requested?: ExportColumn[]): ResolvedExportColumn[] {
  const candidates = module.fields.filter((f) => f.isActive && f.displayType !== 'hidden' && f.config.exportable !== false);
  if (!requested?.length) {
    return candidates.flatMap((field) => withUnitCompanion(module, { field, header: field.label }));
  }
  const byId = new Map(candidates.map((f) => [f.internalId, f]));
  const seen = new Set<string>();
  return requested.flatMap((column): ResolvedExportColumn[] => {
    const field = byId.get(column.fieldId);
    // A deleted/non-exportable field is skipped rather than exposing it just
    // because an old template remembers it.
    if (!field || seen.has(field.internalId)) return [];
    seen.add(field.internalId);
    return withUnitCompanion(module, { field, header: column.header?.trim() || field.label });
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
      // A literal sign, not Excel's `%` format, which multiplies by a hundred.
      // A percent is stored here as the number a person reads — GST is `5`, and
      // `0.00%` would print that as 500.00%.
      if (column.field.uitype === 'percent') cell.numFmt = '0.00"%"';
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
