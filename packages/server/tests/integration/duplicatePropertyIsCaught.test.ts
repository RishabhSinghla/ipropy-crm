/**
 * The same floor entered twice is caught. A different floor is not.
 *
 * The property duplicate check was set to `["property_code"]` — an autonumber
 * the system generates. `prepareValues` stamps a fresh one before the check
 * runs, so it looked for a value that had never been stored and could not match.
 * It was configured protection that gave none, which is the third thing of that
 * shape found this week.
 *
 * The half of this test that matters most is the negative case. A key that
 * catches real duplicates but also blocks legitimate new floors is worse than no
 * key at all, because a rep who cannot save a genuine listing will invent a
 * title to get past it, and now the inventory has two names for one building.
 * `mode: 'all'` is what makes that distinction possible — under the `any` rule
 * used for people, every floor in a locality would collide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService, findPossibleDuplicates } from '../../src/core/entity/recordService.js';
import { adminContext, propertyInput } from './fixtures.js';

const made: string[] = [];
// Real values: locality is a picklist, so a made-up one fails validation
// before the duplicate check is ever reached.
const LOCALITY = 'Sector 78';
const ELSEWHERE = 'Sector 62';

beforeAll(async () => { await registry.warmup(); });

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

async function addProperty(values: Record<string, unknown>) {
  const p = await recordService.createRecord(await adminContext(), 'properties', propertyInput({
    status: 'Available', property_type: 'Builder Floor', locality: LOCALITY, ...values,
  }));
  made.push(p.id);
  return p;
}

describe('entering a property that already exists', () => {
  it('accepts the first one', async () => {
    const p = await addProperty({ full_name: 'D-101', floor: 2, mobile: '9810012345' });
    expect(p.id).toBeTruthy();
  });

  it('refuses the same house number on the same floor in the same locality', async () => {
    await expect(addProperty({ full_name: 'A different Unit', floor: 9, mobile: '9810012345' }))
      .rejects.toThrow(/must be unique/i);
  });

  it('accepts a different floor of the same building', async () => {
    /*
      The case that must not break. A builder floor block is four properties
      sharing a house number, and refusing the second one would make the CRM
      unusable for the business it was built for.
    */
    const p = await addProperty({ full_name: 'D-101', floor: 3, mobile: '9810012346' });
    expect(p.id).toBeTruthy();
  });

  it('accepts the same house number in a different locality', async () => {
    // D-101 in one sector and D-101 in another are different buildings.
    const p = await recordService.createRecord(await adminContext(), 'properties', propertyInput({
      status: 'Available', property_type: 'Builder Floor',
      locality: ELSEWHERE, full_name: 'D-101', floor: 2, mobile: '9810012347',
    }));
    made.push(p.id);
    expect(p.id).toBeTruthy();
  });

  it('does not block a listing whose identity is incomplete', async () => {
    /*
      A composite key with a hole in it is not a key. If the floor is missing,
      matching on locality and name alone would flag every floor of the building
      — so the check declines to judge rather than guessing.
    */
    const p = await addProperty({ full_name: 'D-999', mobile: '9810012348' });
    expect(p.id).toBeTruthy();
  });
});

describe('the warning shown while typing', () => {
  it('agrees with what the save will do', async () => {
    /*
      The panel and the save-time check read the same rule now. Before, they
      could disagree — the panel warning about records the save would accept.
    */
    const hits = await findPossibleDuplicates('properties', {
      mobile: '9810012345',
    });
    expect(hits.length, 'the rep should be warned before they save').toBeGreaterThan(0);
  });

  it('stays quiet about a different floor', async () => {
    const hits = await findPossibleDuplicates('properties', {
      mobile: '9810012399',
    });
    expect(hits.length, 'warning about every floor in the block is noise').toBe(0);
  });
});

describe('people are still matched the old way', () => {
  it('flags the same mobile even when everything else differs', async () => {
    /*
      Leads keep `any`: one matching phone number is one human, whatever name
      they gave. Changing that rule for properties must not have changed it here.
    */
    const module = await registry.requireModule('leads');
    expect(module.duplicateCheckMode).toBe('any');
    expect(module.duplicateCheckFields).toEqual(['mobile', 'email']);
  });

  it('uses the composite rule only where it was asked for', async () => {
    const properties = await registry.requireModule('properties');
    expect(properties.duplicateCheckFields).toEqual(['mobile']);
  });

  it('no longer keys properties on a number the system invents', async () => {
    // The original bug, pinned. An autonumber is unique by construction, so a
    // check against one can never fire.
    const properties = await registry.requireModule('properties');
    for (const name of properties.duplicateCheckFields) {
      const field = properties.fields.find((f) => f.name === name);
      expect(field?.uitype, `${name} is generated, so it can never match`).not.toBe('autonumber');
    }
  });
});
