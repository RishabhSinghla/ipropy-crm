/**
 * The generic CRUD engine, against a real database.
 *
 * Everything in the product funnels through recordService — CLAUDE.md's rule
 * that no module ever gets its own CRUD is only safe if this one code path is
 * genuinely correct for all of them. The unit suite already covers the pure
 * pieces (query builder, filter evaluator, permissions maths); what it cannot
 * see is the part that only exists once SQL actually runs: value coercion into
 * real columns, JSONB round-tripping, soft deletes, the audit trail, and the
 * sharing rules as expressed in a WHERE clause rather than in a pure function.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createRecord, deleteRecord, getRecord, listRecords, massUpdate, restoreRecord,
  transferOwnership, updateRecord, type ServiceContext,
} from '../../src/core/entity/recordService.js';
import { db } from '../../src/db/pool.js';
import { adminContext, contextFor, leadInput, SEEDED } from './fixtures.js';

let admin: ServiceContext;

beforeAll(async () => {
  admin = await adminContext();
});

describe('create', () => {
  it('round-trips a record and derives its label from labelFields', async () => {
    const created = await createRecord(admin, 'leads', leadInput({ first_name: 'Asha', last_name: 'Verma' }));

    expect(created.id).toBeTruthy();
    expect(created.module).toBe('leads');
    expect(created.label).toBe('Asha Verma');
    expect(created.values.first_name).toBe('Asha');

    // Re-read rather than trusting the create response — this is what catches
    // a value that was returned from memory but never actually persisted.
    const fetched = await getRecord(admin, 'leads', created.id);
    expect(fetched?.values.last_name).toBe('Verma');
  });

  it('allocates a record number from the module autonumber', async () => {
    const created = await createRecord(admin, 'leads', leadInput());
    expect(created.recordNumber).toMatch(/^LD-\d+$/);
  });

  it('defaults ownership to the creating user', async () => {
    const executive = await contextFor(SEEDED.executiveA);
    const created = await createRecord(executive, 'leads', leadInput());
    expect(created.ownerId).toBe(executive.user.id);
  });

  it('rejects a missing mandatory field', async () => {
    // `mobile` is the mandatory field on Leads (last_name is NOT NULL at the
    // DB level but intentionally not mandatory in metadata).
    await expect(createRecord(admin, 'leads', { first_name: 'NoMobile', last_name: 'Present' }))
      .rejects.toThrow();
  });

  it('coerces values to their column types rather than storing strings', async () => {
    const created = await createRecord(admin, 'leads', leadInput({ budget_max: '15000000' }));
    const fetched = await getRecord(admin, 'leads', created.id);
    // Money is NUMERIC read back as a JS number (db/pool.ts configures the
    // type parser for this) — a string here would break every price format.
    expect(typeof fetched?.values.budget_max).toBe('number');
    expect(fetched?.values.budget_max).toBe(15000000);
  });

  it('keeps an empty array as an empty array, not null', async () => {
    // CLAUDE.md rule 9: JSONB list columns are NOT NULL DEFAULT '[]', and
    // coerceValue special-cases empty arrays. A null here is a constraint
    // violation waiting to happen.
    const created = await createRecord(admin, 'leads', leadInput({ preferred_locations: [] }));
    const fetched = await getRecord(admin, 'leads', created.id);
    expect(fetched?.values.preferred_locations).toEqual([]);
  });
});

describe('update', () => {
  it('persists a change and leaves untouched fields alone', async () => {
    const created = await createRecord(admin, 'leads', leadInput({ first_name: 'Before', company: 'Acme Realty' }));
    await updateRecord(admin, 'leads', created.id, { first_name: 'After' });

    const fetched = await getRecord(admin, 'leads', created.id);
    expect(fetched?.values.first_name).toBe('After');
    expect(fetched?.values.company).toBe('Acme Realty');
  });

  it('recomputes the label when a label field changes', async () => {
    const created = await createRecord(admin, 'leads', leadInput({ first_name: 'Old', last_name: 'Name' }));
    const updated = await updateRecord(admin, 'leads', created.id, { last_name: 'Changed' });
    expect(updated.label).toBe('Old Changed');
  });

  it('writes an audit row naming the field, the old value and the new', async () => {
    const created = await createRecord(admin, 'leads', leadInput({ company: 'Mumbai Estates' }));
    await updateRecord(admin, 'leads', created.id, { company: 'Bengaluru Estates' });

    // One audit row per write, with the individual field diffs inside a
    // `changes` JSONB array — [{ field, label, from, to }].
    const { rows } = await db.query<{ action: string; changes: { field: string; from: unknown; to: unknown }[] }>(
      `SELECT action, changes FROM ipy_audit
        WHERE record_id = $1 AND action = 'update' ORDER BY created_at DESC LIMIT 1`,
      [created.id],
    );
    expect(rows).toHaveLength(1);

    const change = rows[0].changes.find((c) => c.field === 'company');
    expect(change).toBeDefined();
    expect(change?.from).toBe('Mumbai Estates');
    expect(change?.to).toBe('Bengaluru Estates');
  });
});

describe('JSON-storage fields', () => {
  it('round-trips a value stored in custom_fields JSONB', async () => {
    // publish_to_web is storage:'json' on projects — the other half of the
    // column/JSON split the query builder has to resolve.
    const project = await createRecord(admin, 'projects', {
      name: `Integration Project ${Date.now()}`,
      status: 'New Launch',
      publish_to_web: false,
    });

    const fetched = await getRecord(admin, 'projects', project.id);
    expect(fetched?.values.publish_to_web).toBe(false);

    await updateRecord(admin, 'projects', project.id, { publish_to_web: true });
    const after = await getRecord(admin, 'projects', project.id);
    expect(after?.values.publish_to_web).toBe(true);
  });

  it('filters on a JSON-storage field through the SQL builder', async () => {
    const marker = `JsonFilter ${Date.now()}`;
    await createRecord(admin, 'projects', { name: `${marker} A`, status: 'New Launch', publish_to_web: true });
    await createRecord(admin, 'projects', { name: `${marker} B`, status: 'New Launch', publish_to_web: false });

    const result = await listRecords(admin, 'projects', {
      search: marker,
      filter: { logic: 'AND', conditions: [{ field: 'publish_to_web', operator: 'equals', value: true }] },
    });

    const names = result.rows.map((r) => r.label);
    expect(names).toContain(`${marker} A`);
    expect(names).not.toContain(`${marker} B`);
  });
});

describe('list and filter', () => {
  it('paginates without losing or repeating rows', async () => {
    const first = await listRecords(admin, 'leads', { page: 1, pageSize: 5 });
    const second = await listRecords(admin, 'leads', { page: 2, pageSize: 5 });

    expect(first.rows).toHaveLength(5);
    expect(first.total).toBeGreaterThan(5);
    const overlap = first.rows.filter((r) => second.rows.some((s) => s.id === r.id));
    expect(overlap).toHaveLength(0);
  });

  it('applies a filter as SQL, not in memory', async () => {
    const marker = `Filterable-${Date.now()}`;
    await createRecord(admin, 'leads', leadInput({ last_name: marker, company: 'Nagpur Realty' }));

    const result = await listRecords(admin, 'leads', {
      filter: { logic: 'AND', conditions: [{ field: 'company', operator: 'equals', value: 'Nagpur Realty' }] },
    });

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.rows.every((r) => r.values.company === 'Nagpur Realty')).toBe(true);
  });

  it('sorts by a column field', async () => {
    const result = await listRecords(admin, 'leads', { sortBy: 'created_at', sortDir: 'desc', pageSize: 10 });
    const times = result.rows.map((r) => new Date(r.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('soft delete and restore', () => {
  it('hides a deleted record from reads but keeps the row', async () => {
    const created = await createRecord(admin, 'leads', leadInput());
    await deleteRecord(admin, 'leads', created.id);

    // A deleted record is indistinguishable from a nonexistent one to the
    // caller: getRecord raises "not found" rather than returning null, so the
    // recycle bin can't be probed for what used to exist.
    await expect(getRecord(admin, 'leads', created.id)).rejects.toThrow(/not found/i);

    const { rows } = await db.query<{ is_deleted: boolean }>(
      'SELECT is_deleted FROM ipy_record WHERE id = $1', [created.id],
    );
    expect(rows[0]?.is_deleted).toBe(true);
  });

  it('brings a record back on restore', async () => {
    const created = await createRecord(admin, 'leads', leadInput({ last_name: 'Restorable' }));
    await deleteRecord(admin, 'leads', created.id);
    await restoreRecord(admin, 'leads', created.id);

    const fetched = await getRecord(admin, 'leads', created.id);
    expect(fetched?.values.last_name).toBe('Restorable');
  });

  it('excludes deleted records from lists and counts', async () => {
    const marker = `Deletable-${Date.now()}`;
    const a = await createRecord(admin, 'leads', leadInput({ last_name: marker }));
    await createRecord(admin, 'leads', leadInput({ last_name: marker }));

    const before = await listRecords(admin, 'leads', { search: marker });
    await deleteRecord(admin, 'leads', a.id);
    const after = await listRecords(admin, 'leads', { search: marker });

    expect(after.total).toBe(before.total - 1);
    expect(after.rows.some((r) => r.id === a.id)).toBe(false);
  });
});

describe('bulk operations', () => {
  it('mass-updates every record it is given', async () => {
    const marker = `Bulk-${Date.now()}`;
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await createRecord(admin, 'leads', leadInput({ last_name: marker }))).id);
    }

    const result = await massUpdate(admin, 'leads', ids, { company: 'Surat Realty' });
    expect(result.updated).toBe(3);
    expect(result.failed).toHaveLength(0);

    for (const id of ids) {
      expect((await getRecord(admin, 'leads', id))?.values.company).toBe('Surat Realty');
    }
  });

  it('reassigns ownership in bulk', async () => {
    const target = await contextFor(SEEDED.executiveB);
    const ids = [
      (await createRecord(admin, 'leads', leadInput())).id,
      (await createRecord(admin, 'leads', leadInput())).id,
    ];

    await transferOwnership(admin, 'leads', ids, target.user.id);

    for (const id of ids) {
      expect((await getRecord(admin, 'leads', id))?.ownerId).toBe(target.user.id);
    }
  });
});

describe('permission enforcement', () => {
  it('refuses a module the user has no access to', async () => {
    // Marketing has no business in Payments; the profile permissions say so.
    const marketing = await contextFor(SEEDED.marketing);
    await expect(listRecords(marketing, 'payments', {})).rejects.toThrow();
  });

  it('strips hidden fields from record data, not just from the describe endpoint', async () => {
    // CLAUDE.md rule 5 — the regression this guards against is real: hiding a
    // field only in metadata leaves it readable through the data API.
    // Properties is the module where the seed actually restricts fields: a
    // tele-caller is not allowed to see the cost basis (base_price,
    // rate_per_sqft, plc_charge…). Reading the hidden set from the database
    // rather than hardcoding it means this keeps testing the real policy even
    // if the seed's choices change.
    const telecaller = await contextFor(SEEDED.telecaller);

    const { rows: hidden } = await db.query<{ name: string }>(
      `SELECT f.name FROM ipy_profile_field_perm pf
         JOIN ipy_field f ON f.id = pf.field_id
         JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'properties' AND pf.profile_id = $1 AND pf.permission = 'hidden'`,
      [telecaller.user.profileId],
    );
    // A vacuous pass would be worse than a failure here — if nothing is
    // hidden, this test proves nothing about stripping.
    expect(hidden.length).toBeGreaterThan(0);

    const visible = await listRecords(telecaller, 'properties', { pageSize: 1 });
    expect(visible.rows.length).toBe(1);
    const propertyId = visible.rows[0].id;

    const asAdmin = await getRecord(admin, 'properties', propertyId);
    const asTelecaller = await getRecord(telecaller, 'properties', propertyId);

    for (const { name } of hidden) {
      expect(Object.keys(asAdmin?.values ?? {})).toContain(name);
      expect(Object.keys(asTelecaller?.values ?? {})).not.toContain(name);
    }

    // The list path strips independently of the read path, so check both.
    expect(Object.keys(visible.rows[0].values)).not.toContain(hidden[0].name);
  });

  it('scopes a list to what the user may see', async () => {
    // An executive must never see more than an admin — the exact numbers
    // depend on the seeded sharing rules, so assert the invariant, not a count.
    const executive = await contextFor(SEEDED.executiveA);
    const asAdmin = await listRecords(admin, 'leads', { pageSize: 1 });
    const asExecutive = await listRecords(executive, 'leads', { pageSize: 1 });

    expect(asExecutive.total).toBeLessThanOrEqual(asAdmin.total);
  });
});
