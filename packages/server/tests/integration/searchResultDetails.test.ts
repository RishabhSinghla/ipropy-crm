import { beforeAll, expect, it } from 'vitest';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, leadInput } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof adminContext>>;
beforeAll(async () => { await registry.warmup(); ctx = await adminContext(); });

it('includes mobile and property facts on authorised search hits', async () => {
  const name = `SearchDetails${Date.now()}`;
  const record = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: name, budget: 12500000 }));
  const hit = (await recordService.globalSearch(ctx, name)).find((item) => item.id === record.id);
  expect(hit).toBeDefined();
  expect(hit?.mobile).toBeTruthy();
  expect(hit?.details).toContain('1.25');
  expect(await recordService.countRecords(ctx, 'leads', { search: name })).toBe(1);
  const listed = await recordService.listRecords(ctx, 'leads', { search: name });
  expect(listed.rows[0]?.display?.owner_id).toBeTruthy();
});
