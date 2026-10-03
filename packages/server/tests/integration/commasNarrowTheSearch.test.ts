/**
 * The list's search box reads commas as "and".
 *
 * **3 October 2026, the owner:** *"we can filter any values from this filter as
 * many as by given comma, i.e 2 BHK, 50L, For Sale, Neharpar Etc. in same
 * search."*
 *
 * A real database, because this is SQL: the clause is a string, so typecheck
 * sees nothing and a mocked `db.query` would accept any statement at all —
 * which is how a column name that had never existed once shipped.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { recordService } from '../../src/core/entity/recordService.js';
import { registry } from '../../src/core/metadata/registry.js';
import { adminContext, leadInput } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof adminContext>>;
let marker = '';

beforeAll(async () => {
  await registry.warmup();
  ctx = await adminContext();
  marker = `Comma${Date.now()}`;
  await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${marker} Sharma`, company: 'Neharpar Estates' }));
  await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${marker} Verma`, company: 'Sector 50 Homes' }));
});

const found = async (search: string): Promise<string[]> => {
  const page = await recordService.listRecords(ctx, 'leads', { search, pageSize: 50 });
  return page.rows.map((row) => row.label);
};

describe('commas narrow the search', () => {
  it('still answers a plain phrase the way it always did', async () => {
    expect(await found(marker)).toHaveLength(2);
  });

  it('asks for every piece, not any of them', async () => {
    const both = await found(`${marker}, Neharpar`);
    expect(both).toHaveLength(1);
    expect(both[0]).toContain('Sharma');
  });

  it('answers nothing when one piece matches nobody', async () => {
    // The interesting half: an OR would have answered two here, which reads as
    // the commas doing nothing at all.
    expect(await found(`${marker}, Neharpar, Sector 50`)).toHaveLength(0);
  });

  it('ignores spacing and a trailing comma, which is what people type', async () => {
    expect(await found(`  ${marker} ,  Neharpar , `)).toHaveLength(1);
  });
});
