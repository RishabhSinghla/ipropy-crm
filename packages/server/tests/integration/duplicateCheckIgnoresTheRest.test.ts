/**
 * Who this row is, decided by the fields that say who somebody is.
 *
 * The identity lookup used to prepare the *whole* row, and preparation
 * validates. So one unknown locality — on a field with nothing to do with
 * identity — threw, the importer read the throw as "nobody like this here",
 * and an import in update mode quietly created a second copy of a person whose
 * mobile number was right there in the same row.
 *
 * The second half matters as much: a partial set of values is what this is, so
 * it must not demand every mandatory field either.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext } from './fixtures.js';

const MOBILE = `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const NAME = `QA Identity ${Date.now().toString(36)}`;
let scope: Awaited<ReturnType<typeof adminContext>>;

beforeAll(async () => {
  await registry.warmup();
  scope = await adminContext();
  await recordService.createRecord(scope, 'leads', { full_name: NAME, mobile: MOBILE, status: 'New' });
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record r USING ipy_e_leads l
                   WHERE l.record_id = r.id AND l.mobile = $1`, [MOBILE]);
});

describe('finding the record a row belongs to', () => {
  it('recognises the person even when another value on the row is nonsense', async () => {
    const found = await recordService.findDuplicateRecord('leads', {
      full_name: NAME,
      mobile: MOBILE,
      preferred_locations: 'Nowhere That Exists',
    });
    expect(found?.label, 'the mobile identifies this person whatever else the row says').toBeTruthy();
  });

  it('does not demand the mandatory fields it was not given', async () => {
    const found = await recordService.findDuplicateRecord('leads', { mobile: MOBILE });
    expect(found?.label).toBeTruthy();
  });

  it('still says no when nothing identifies the row', async () => {
    const found = await recordService.findDuplicateRecord('leads', { full_name: NAME });
    expect(found).toBeNull();
  });
});
