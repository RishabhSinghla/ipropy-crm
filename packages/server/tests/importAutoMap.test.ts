import { describe, expect, it } from 'vitest';
import { suggestMapping, certainMapping } from '../src/core/import/autoMap.js';
import { field } from './helpers.js';

/** A Contacts module shaped like production's. */
const leads = [
  field({ name: 'full_name', uitype: 'string', label: 'Full Name' }),
  field({ name: 'mobile', uitype: 'phone', label: 'Mobile' }),
  field({ name: 'alternate_phone', uitype: 'phone', label: 'Alternate Phone' }),
  field({ name: 'email', uitype: 'email', label: 'Email' }),
  field({ name: 'contact_type', uitype: 'picklist', label: 'Type' }),
  field({ name: 'lead_status', uitype: 'picklist', label: 'Pipeline Status' }),
  field({ name: 'lead_source', uitype: 'picklist', label: 'Lead Source' }),
  field({ name: 'configuration', uitype: 'multipicklist', label: 'Bedrooms Wanted' }),
  field({ name: 'budget', uitype: 'currency', label: 'Budget / Demand' }),
  field({ name: 'area', uitype: 'area', label: 'Area' }),
  field({ name: 'area_unit', uitype: 'picklist', label: 'Area Unit', displayType: 'hidden', config: { unitMaster: 'area' } }),
  field({ name: 'next_followup_at', uitype: 'date', label: 'Next Follow-up' }),
];

const rows = [
  { 'Customer Name': 'Rajesh Sharma', 'Mobile No': '+91 98100 12345', Budget: '1.75 Cr',
    Area: '250', Unit: 'Sq. Yds.', Requirement: '3 BHK', Status: 'Available', 'Next Follow Up': '15-03-2026' },
];

describe('guessing what a spreadsheet column means', () => {
  it('maps a real file without help', () => {
    const headers = Object.keys(rows[0]!);
    const mapped = certainMapping(suggestMapping(leads, headers, rows));
    expect(mapped).toEqual({
      'Customer Name': 'full_name',
      'Mobile No': 'mobile',
      Budget: 'budget',
      Area: 'area',
      Unit: 'area_unit',
      Requirement: 'configuration',
      Status: 'lead_status',
      'Next Follow Up': 'next_followup_at',
    });
  });

  it('offers the unit companion even though the form hides it', () => {
    // `area_unit` is hidden because the form shows one combined control. A
    // spreadsheet keeps the amount and the unit in two columns, so refusing it
    // as a target sent a column headed `Unit` to `contact_type`.
    const s = suggestMapping(leads, ['Unit'], [{ Unit: 'Sq. Yds.' }]);
    expect(s[0]?.field).toBe('area_unit');
  });

  it('will not let one synonym claim two fields', () => {
    // `Type` is the label of Contact Type as much as a word for configuration.
    // A synonym that matches two fields is worse than none.
    const s = suggestMapping(leads, ['Requirement'], [{ Requirement: '3 BHK' }]);
    expect(s[0]).toMatchObject({ field: 'configuration', confidence: 'certain' });
  });

  it('does not commit a guess it is unsure of', () => {
    // Two phone fields and a header that names neither: offered, not filled in.
    const s = suggestMapping(leads, ['Some Number'], [{ 'Some Number': '9810012345' }]);
    expect(certainMapping(s)['Some Number']).toBeUndefined();
  });

  it('never maps two columns to the same field', () => {
    const s = suggestMapping(leads, ['Mobile', 'Mobile No'], [
      { Mobile: '9810012345', 'Mobile No': '9820012345' },
    ]);
    const fields = s.map((x) => x.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});
