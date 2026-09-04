/**
 * A lead needs one way to reach them, not one particular way.
 *
 * `mobile` was mandatory on its own, so an enquiry carrying only an email could
 * not be saved at all — which is the shape an NRI buyer, or anyone who would
 * rather be emailed first, actually arrives in.
 *
 * The rejected leads were not the real damage. What a rep does when the form
 * refuses to save is type a number that gets past validation, and a fake mobile
 * is worse than a blank one: a blank is honest, and a fake is indistinguishable
 * from a real number forever afterwards. The stricter rule produced worse data.
 *
 * The rule now lives on the module (`settings.requireOneOf`) rather than on
 * either field, because it is a statement about a *pair* — neither is mandatory
 * alone, which is precisely what a per-field flag cannot say.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext } from './fixtures.js';

const made: string[] = [];
let n = 9811598000;
const freshMobile = () => String(n++);

beforeAll(async () => { await registry.warmup(); });

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

async function create(values: Record<string, unknown>) {
  const lead = await recordService.createRecord(await adminContext(), 'leads', {
    full_name: 'Reachability Test', ...values,
  });
  made.push(lead.id);
  return lead;
}

async function update(id: string, values: Record<string, unknown>) {
  return recordService.updateRecord(await adminContext(), 'leads', id, values);
}

describe('creating a lead', () => {
  it('accepts somebody who left only an email address', async () => {
    // The case that could not be saved at all. An NRI buyer enquiring from
    // abroad is the obvious one, and this business sells to those buyers.
    const lead = await create({ email: `nri-${n++}@example.com` });
    expect(lead.id).toBeTruthy();
  });

  it('accepts somebody who left only a phone number', async () => {
    const lead = await create({ mobile: freshMobile() });
    expect(lead.id).toBeTruthy();
  });

  it('accepts somebody who left both', async () => {
    const lead = await create({ mobile: freshMobile(), email: `both-${n++}@example.com` });
    expect(lead.id).toBeTruthy();
  });

  it('still refuses a lead nobody can contact', async () => {
    /*
      Relaxing the rule must not become no rule. A record with neither a number
      nor an address is not a lead, it is a name — and it will sit in the list
      forever because there is nothing anyone can do with it.
    */
    await expect(create({ full_name: 'Unreachable' }))
      .rejects.toThrow(/mobile|email/i);
  });

  it('says which two fields it means, once', async () => {
    // "Mobile is required; Email is required" reads as needing both. The
    // message has to say "or", and say it a single time.
    let message = '';
    try {
      await create({ full_name: 'Unreachable' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.toLowerCase()).toContain(' or ');
    expect(
      message.match(/required/gi)?.length,
      'one requirement stated once, not one per field',
    ).toBe(1);
  });
});

describe('editing an existing lead', () => {
  it('does not fail an edit that touches neither field', async () => {
    /*
      The rule is checked against the record merged with the payload, not the
      payload alone. Otherwise changing somebody's budget would be refused for
      not re-sending a phone number that is already stored.
    */
    const lead = await create({ mobile: freshMobile() });
    const updated = await update(lead.id, { budget: 14000000 });
    expect(updated.id).toBe(lead.id);
  });

  it('refuses an edit that would remove the last way to reach them', async () => {
    // Blanking the only contact detail is the same fault as never supplying
    // one, and it arrives through a different door.
    const lead = await create({ mobile: freshMobile() });
    await expect(update(lead.id, { mobile: '' })).rejects.toThrow(/mobile|email/i);
  });

  it('allows swapping one for the other', async () => {
    // Somebody who gives an email later and asks you to stop using their
    // number is making a reasonable request, and it must not be refused.
    const lead = await create({ mobile: freshMobile() });
    const updated = await update(lead.id, {
      mobile: '', email: `swapped-${n++}@example.com`,
    });
    expect(updated.id).toBe(lead.id);
  });
});

describe('the rule itself', () => {
  it('is metadata, not code', async () => {
    /*
      Pinned because the value of this fix is that it is reachable. A rule
      hardcoded as `if (module === 'leads')` would be invisible to him and would
      need a deploy to change.
    */
    const row = await db.queryOne<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM ipy_module WHERE name = 'leads'`,
    );
    expect(row?.settings.requireOneOf).toEqual([['mobile', 'email']]);

    const module = await registry.requireModule('leads');
    expect(module.requireOneOf).toEqual([['mobile', 'email']]);
  });

  it('leaves neither field mandatory on its own', async () => {
    const module = await registry.requireModule('leads');
    for (const name of ['mobile', 'email']) {
      const field = module.fields.find((f) => f.name === name);
      expect(field?.isMandatory, `${name} must not be individually mandatory`).toBe(false);
    }
  });
});
