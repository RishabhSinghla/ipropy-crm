/**
 * A WhatsApp number finds the right contact, and refuses to guess.
 *
 * Nothing but a real database proves this. The query builds its comparisons
 * from whatever phone fields the module has and reads them through
 * `fieldText`, so the SQL is a string assembled at runtime — typecheck sees
 * nothing, and a mocked `db.query` accepts any parameter list at all. That is
 * exactly how lead scoring silently stopped writing for a day.
 *
 * The behaviour that matters most here is the refusal. Two people holding one
 * number is a real thing — a family, an office line — and picking the more
 * recently updated of them files a customer's conversation on a stranger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { matchContact } from '../../src/integrations/whatsapp/agent/matchContact.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
/** A number no seeded or imported row can be holding. */
const national = String(9_000_000_000 + (stamp % 99_000_000));
const created: string[] = [];

beforeAll(async () => {
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `WhatsApp Match ${stamp}`,
    mobile: national,
  });
  created.push(lead.id);
});

afterAll(async () => {
  for (const id of created) {
    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [id]).catch(() => undefined);
  }
});

describe('matching a WhatsApp number to a contact', () => {
  it('finds the lead however the number is written', async () => {
    for (const shape of [national, `+91${national}`, `+91 ${national}`, `91-${national}`]) {
      const match = await matchContact('leads', shape);
      expect(match, shape).toMatchObject({ kind: 'one', recordId: created[0] });
    }
  });

  it('answers "nobody" for a number the CRM has never seen', async () => {
    const match = await matchContact('leads', '+919999000011');
    expect(match.kind).toBe('none');
  });

  it('answers "nobody" rather than erroring on rubbish', async () => {
    for (const bad of ['', '12345', 'not a number', null]) {
      expect((await matchContact('leads', bad)).kind, String(bad)).toBe('none');
    }
  });

  it('refuses to choose when two records hold the same number', async () => {
    /*
      Not two leads with the same *mobile* — the CRM already refuses that, which
      this test discovered by being told so. `findDuplicate` raises a
      ConflictError on create, so that collision cannot be made through the app.

      It arrives the other way instead: the same number sitting in a different
      phone field on somebody else. A husband's mobile as his wife's alternate
      contact, an office line on three records, or anything an import wrote
      without passing validation. Rarer, entirely real, and the case where
      picking the more recently updated record files a customer's conversation
      on a stranger.
    */
    const ctx = await adminContext();
    const twin = await recordService.createRecord(ctx, 'leads', {
      full_name: `WhatsApp Match Twin ${stamp}`,
      mobile: String(Number(national) - 1),
      alternate_phone: national,
    });
    created.push(twin.id);

    const match = await matchContact('leads', `+91${national}`);
    expect(match.kind).toBe('ambiguous');
    if (match.kind === 'ambiguous') {
      expect(match.candidates.map((c) => c.recordId).sort())
        .toEqual([created[0], twin.id].sort());
    }
  });

  it('says nobody for a module that does not exist, instead of throwing', async () => {
    expect((await matchContact('no_such_module', `+91${national}`)).kind).toBe('none');
  });
});
