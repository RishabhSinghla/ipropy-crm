/**
 * The org-wide change log printed raw ids and stored values.
 *
 * "Assigned To: 671d65cc-1ac6-… → 58f5465a-a122-…" is what an admin actually
 * saw under System & Audit on 16 September 2026, while the same edit on the
 * record's own Changes tab read as two people's names. The record timeline had
 * a resolver and the org-wide log had none, so the two screens disagreed about
 * the same event — and a dropdown's stored value is routinely not the word on
 * screen, which is a confusion this CRM has already paid for once.
 *
 * `describeChanges` is now the single resolver behind both. The case these
 * tests exist for, which the old per-record version could not have, is the
 * fourth: an org-wide log carries several modules at once, and `status` means
 * different things in each.
 */
import { describe, expect, it } from 'vitest';
import { describeChanges } from '../src/core/entity/auditChanges.js';

const OWNER_A = '671d65cc-1ac6-4bc9-b5fd-f4fee85261f7';
const OWNER_B = '58f5465a-a122-4e8c-b347-6bf8a9ee5766';

/** A stand-in for the pool that answers each of the five lookups by shape. */
function fakeConn(rows: {
  users?: { id: string; name: string }[];
  records?: { id: string; name: string }[];
  fields?: { module: string; key: string; label: string; uitype: string }[];
  options?: { module: string; key: string; value: string; label: string }[];
}) {
  return {
    query: async (sql: string) => {
      if (sql.includes('ipy_user')) return { rows: rows.users ?? [] };
      if (sql.includes('ipy_group')) return { rows: [] };
      if (sql.includes('FROM ipy_record')) return { rows: rows.records ?? [] };
      if (sql.includes('ipy_picklist_value')) return { rows: rows.options ?? [] };
      return { rows: rows.fields ?? [] };
    },
  } as never;
}

describe('describeChanges', () => {
  it('turns an owner id into the person’s name', async () => {
    const [row] = await describeChanges(
      [{ module_name: 'leads', changes: [{ field: 'owner_id', label: 'Owner', from: OWNER_A, to: OWNER_B }] }],
      {
        conn: fakeConn({
          users: [{ id: OWNER_A, name: 'Deepak Goswami' }, { id: OWNER_B, name: 'Yogesh Bindal' }],
          fields: [{ module: 'leads', key: 'owner_id', label: 'Assigned To', uitype: 'owner' }],
        }),
      },
    );
    const change = (row.changes as Record<string, unknown>[])[0]!;
    expect(change.fromDisplay).toBe('Deepak Goswami');
    expect(change.toDisplay).toBe('Yogesh Bindal');
    // And captioned with what the field is called now, not on the day.
    expect(change.label).toBe('Assigned To');
  });

  it('says the word on the screen, not the word in the column', async () => {
    const [row] = await describeChanges(
      [{ module_name: 'leads', changes: [{ field: 'status', label: 'Lead Status', from: 'Contacted', to: 'Converted' }] }],
      {
        conn: fakeConn({
          fields: [{ module: 'leads', key: 'status', label: 'Lead Status', uitype: 'picklist' }],
          options: [
            { module: 'leads', key: 'status', value: 'Contacted', label: 'Lead Won' },
            { module: 'leads', key: 'status', value: 'Converted', label: 'Deal Won' },
          ],
        }),
      },
    );
    const change = (row.changes as Record<string, unknown>[])[0]!;
    expect(change.fromDisplay).toBe('Lead Won');
    expect(change.toDisplay).toBe('Deal Won');
  });

  it('writes money the way the rest of the CRM writes it', async () => {
    const [row] = await describeChanges(
      [{ module_name: 'leads', changes: [{ field: 'budget', label: 'Budget', from: 0, to: 35000000 }] }],
      { conn: fakeConn({ fields: [{ module: 'leads', key: 'budget', label: 'Budget', uitype: 'currency' }] }) },
    );
    const change = (row.changes as Record<string, unknown>[])[0]!;
    expect(change.toDisplay).toContain('3.5');
    // Zero is rendered, not hidden. The public site reads a price of 0 as
    // "Price on request", but a change log answers a different question — what
    // the record held — and it held nought, which is not the same as blank.
    expect(change.fromDisplay).toBe('₹0');
  });

  it('keeps two modules apart when the field name is the same', async () => {
    // This is what the org-wide log made possible and the per-record resolver
    // never had to face: `status` is Lead Status on a contact and Property
    // Status on a unit, with entirely different options behind each.
    const described = await describeChanges(
      [
        { module_name: 'leads', changes: [{ field: 'status', label: 'x', from: null, to: 'Contacted' }] },
        { module_name: 'properties', changes: [{ field: 'status', label: 'x', from: null, to: 'Available' }] },
      ],
      {
        conn: fakeConn({
          fields: [
            { module: 'leads', key: 'status', label: 'Lead Status', uitype: 'picklist' },
            { module: 'properties', key: 'status', label: 'Property Status', uitype: 'picklist' },
          ],
          options: [
            { module: 'leads', key: 'status', value: 'Contacted', label: 'Lead Won' },
            { module: 'properties', key: 'status', value: 'Available', label: 'Ready to sell' },
          ],
        }),
      },
    );
    const lead = (described[0]!.changes as Record<string, unknown>[])[0]!;
    const unit = (described[1]!.changes as Record<string, unknown>[])[0]!;
    expect(lead.label).toBe('Lead Status');
    expect(lead.toDisplay).toBe('Lead Won');
    expect(unit.label).toBe('Property Status');
    expect(unit.toDisplay).toBe('Ready to sell');
  });

  it('leaves an id it cannot place exactly as it was', async () => {
    // A deleted user, or an id belonging to something this does not look up.
    // Inventing a name would be worse than showing the id.
    const [row] = await describeChanges(
      [{ module_name: 'leads', changes: [{ field: 'owner_id', label: 'Assigned To', from: null, to: OWNER_A }] }],
      { conn: fakeConn({ fields: [{ module: 'leads', key: 'owner_id', label: 'Assigned To', uitype: 'owner' }] }) },
    );
    const change = (row.changes as Record<string, unknown>[])[0]!;
    expect(change.toDisplay).toBeUndefined();
    expect(change.to).toBe(OWNER_A);
  });

  it('does nothing at all to an empty page of history', async () => {
    expect(await describeChanges([])).toEqual([]);
  });
});
