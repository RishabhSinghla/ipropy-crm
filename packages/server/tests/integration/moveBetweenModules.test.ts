/**
 * Moving a record from one module to the other, in both directions.
 *
 * The owner reported it on 20 September: *"Bug in Move to Lead"* — the dialog
 * answered "Lead Status is required" and the record stayed where it was.
 *
 * The cause is worth keeping, because nothing errored where the mistake was.
 * `moveRecord` deliberately drops both modules' stage values — "Available" is
 * not a thing a person can be — and left the destination to "apply its own
 * mandatory default". **Neither module's stage field has a default**: both are
 * mandatory with an empty `default_value`, so the move failed validation every
 * single time, in both directions, since the day it was written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { getModule } from '../../src/core/metadata/registry.js';
import { adminContext, propertyInput } from './fixtures.js';

const stamp = Date.now();
let ctx: Awaited<ReturnType<typeof adminContext>>;
const created: string[] = [];

/** The first option of a module's stage dropdown — what a move should land on. */
async function startingStage(moduleName: string): Promise<string> {
  const module = await getModule(moduleName);
  const field = module!.fields.find((f) => f.name === module!.pipelineField)
    ?? module!.fields.find((f) => f.columnName === module!.pipelineField);
  return String(field!.defaultValue ?? field!.options?.[0]?.value ?? '');
}

beforeAll(async () => { ctx = await adminContext(); });

afterAll(async () => {
  for (const id of created) {
    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [id]).catch(() => undefined);
  }
});

describe('moving a record between the two modules', () => {
  it('moves a unit to Contacts and starts it at the first Lead Status', async () => {
    const property = await recordService.createRecord(
      ctx, 'properties', propertyInput({ full_name: `Move To Lead ${stamp}` }),
    );
    created.push(property.id);

    const moved = await recordService.moveRecord(ctx, 'properties', property.id, 'leads');
    created.push(moved.id);

    const module = await getModule('leads');
    const stage = module!.fields.find((f) => f.columnName === 'status' || f.name === 'status');
    expect(moved.values[stage!.name], 'the moved record has no stage at all')
      .toBe(await startingStage('leads'));
  });

  it('moves a contact to Inventory the same way', async () => {
    const lead = await recordService.createRecord(ctx, 'leads', {
      full_name: `Move To Unit ${stamp}`,
      mobile: `94${String(stamp).slice(-8)}`,
    });
    created.push(lead.id);

    const moved = await recordService.moveRecord(ctx, 'leads', lead.id, 'properties');
    created.push(moved.id);

    const module = await getModule('properties');
    const stage = module!.fields.find((f) => f.columnName === 'status' || f.name === 'status');
    expect(moved.values[stage!.name]).toBe(await startingStage('properties'));
  });

  it('never carries the other module\'s stage across', async () => {
    /*
      "Available" is not a thing a person can be. A unit moved to Contacts must
      not arrive holding a property status, whatever the two dropdowns happen
      to have in common.
    */
    const property = await recordService.createRecord(
      ctx, 'properties', propertyInput({ full_name: `Move Stage ${stamp}` }),
    );
    created.push(property.id);
    const moved = await recordService.moveRecord(ctx, 'properties', property.id, 'leads');
    created.push(moved.id);

    const leadStatuses = (await getModule('leads'))!.fields
      .find((f) => f.columnName === 'status')!.options?.map((option) => option.value) ?? [];
    const stage = (await getModule('leads'))!.fields.find((f) => f.columnName === 'status')!;
    expect(leadStatuses).toContain(String(moved.values[stage.name]));
  });
});
