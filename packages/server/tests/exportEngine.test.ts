import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildExport, resolveExportColumns } from '../src/core/export/engine.js';
import { field, module } from './helpers.js';

describe('universal export engine', () => {
  const phone = field({ name: 'mobile', uitype: 'phone' });
  const demand = field({ name: 'demand', uitype: 'currency' });
  const meta = module({ name: 'properties', fields: [phone, demand] });

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
    expect(sheet.getRow(1).values).toEqual([, 'Asking price', 'Owner phone']);
    expect(sheet.getRow(2).getCell(1).value).toBe(16000000);
    expect(sheet.getRow(2).getCell(2).value).toBe('09876543210');
    expect(sheet.getRow(2).getCell(2).numFmt).toBe('@');
  });

  it('does not revive a deleted field from an old saved template', () => {
    expect(resolveExportColumns(meta, [{ fieldId: 'fld_missing', header: 'Gone' }])).toEqual([]);
  });
});
