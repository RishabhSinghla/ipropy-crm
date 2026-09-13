import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildExport, resolveExportColumns } from '../src/core/export/engine.js';
import { field, module } from './helpers.js';

describe('universal export engine', () => {
  const phone = field({ name: 'mobile', uitype: 'phone' });
  const demand = field({ name: 'demand', uitype: 'currency' });
  const meta = module({ name: 'properties', fields: [phone, demand] });

  it('exports the unit beside the amount it belongs to', async () => {
    /*
      ₹26,000,000 in a spreadsheet is not an answer on its own — the CRM stores
      whether that is a total or a rate per square yard in a companion picklist
      the form hides, and an export that drops it makes the number unreadable
      to the one person who cannot ask.
    */
    const budgetUnit = field({ name: 'budget_unit', uitype: 'picklist', displayType: 'hidden' });
    const budget = field({ name: 'budget', uitype: 'currency', label: 'Budget / Demand', config: { unitField: 'budget_unit' } });
    const withUnits = module({ name: 'leads', fields: [budget, budgetUnit] });

    const columns = resolveExportColumns(withUnits, [{ fieldId: budget.internalId }]);
    expect(columns.map((c) => c.header)).toEqual(['Budget / Demand', 'Budget / Demand Unit']);

    // And on a default export, where no columns were chosen at all: the unit
    // sits immediately after its amount rather than at the end of the sheet.
    const all = resolveExportColumns(withUnits).map((c) => c.header);
    expect(all.indexOf('Budget / Demand Unit')).toBe(all.indexOf('Budget / Demand') + 1);

    const file = await buildExport('csv', columns, [{ values: { budget: 26000000, budget_unit: 'Per Sq. Yd.' } }]);
    expect(file.content.toString('utf8')).toContain('26000000,Per Sq. Yd.');
  });

  it('uses permanent Field IDs and preserves phone numbers in Excel', async () => {
    const columns = resolveExportColumns(meta, [
      { fieldId: demand.internalId, header: 'Asking price' },
      { fieldId: phone.internalId, header: 'Owner phone' },
    ]);
    const file = await buildExport('xlsx', columns, [{
      values: { demand: 16000000, mobile: '09876543210' },
      display: { demand: '₹1.60 Cr' },
    }]);
    expect(file.extension).toBe('xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.content);
    const sheet = workbook.getWorksheet('Export')!;
    // The hole is deliberate: ExcelJS numbers columns from 1, so `values[0]`
    // is always empty. Writing `undefined` there would read as a column whose
    // header we forgot rather than a column that does not exist.
    // eslint-disable-next-line no-sparse-arrays
    expect(sheet.getRow(1).values).toEqual([, 'Asking price', 'Owner phone']);
    expect(sheet.getRow(2).getCell(1).value).toBe(16000000);
    expect(sheet.getRow(2).getCell(2).value).toBe('09876543210');
    expect(sheet.getRow(2).getCell(2).numFmt).toBe('@');
  });

  it('does not revive a deleted field from an old saved template', () => {
    expect(resolveExportColumns(meta, [{ fieldId: 'fld_missing', header: 'Gone' }])).toEqual([]);
  });
});
