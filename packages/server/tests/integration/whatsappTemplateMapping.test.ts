/**
 * What fills a template's blanks, and what must never overwrite it.
 *
 * A WhatsApp template is approved with its wording frozen, so the only thing
 * the CRM decides is what goes in each `{{n}}`. Four things only a real
 * database and the real metadata can answer:
 *
 *  * a mapping resolves through **metadata**, so `{{1}} → Full Name` fills
 *    from the record rather than from a field name written into code;
 *  * a picklist fills with its *label*, because the stored value is a
 *    different string and the customer would read the wrong one;
 *  * an empty field is named rather than silently sent as a gap — WhatsApp
 *    refuses the message anyway, and "failed" tells a rep nothing;
 *  * syncing from the provider updates the wording and **leaves the mapping
 *    alone**, because a sync to pick up one new template must not empty the
 *    blanks on the other twelve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { resolveTemplate, saveMapping } from '../../src/integrations/whatsapp/business/templates.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const NAME = `site_visit_${stamp}`;

let templateId = '';
let recordId = '';
let ctx: Awaited<ReturnType<typeof adminContext>>;

beforeAll(async () => {
  ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `Template Mapping ${stamp}`,
    mobile: `96${String(stamp).slice(-8)}`,
    status: 'New',
  });
  recordId = lead.id;

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_whatsapp_template (name, language, category, status, body_text)
     VALUES ($1, 'en', 'UTILITY', 'APPROVED',
             'Hello {{1}}, your visit is confirmed. Status: {{2}}. Call {{3}} — {{4}}.')
     RETURNING id`,
    [NAME],
  );
  templateId = row!.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_whatsapp_template WHERE name = $1`, [NAME]);
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('template field mapping', () => {
  it('refuses a mapping that names a field the module does not have', async () => {
    await expect(saveMapping(templateId, 'leads', { 1: 'field:not_a_field' }))
      .rejects.toThrow(/no field called/i);
  });

  it('refuses a source that is not a field, the agent, the business or a literal', async () => {
    await expect(saveMapping(templateId, 'leads', { 1: 'javascript:alert(1)' }))
      .rejects.toThrow(/not something a template can be filled from/i);
  });

  it('fills the blanks from the record, through metadata', async () => {
    await saveMapping(templateId, 'leads', {
      1: 'field:full_name',
      2: 'field:status',
      3: 'agent:name',
      4: 'org:name',
    });

    const resolved = await resolveTemplate({
      ctx, templateId, module: 'leads', recordId,
      agentName: 'Shikha Jha', orgName: 'iPropy Realty',
    });

    expect(resolved.missing, JSON.stringify(resolved.missing)).toHaveLength(0);
    expect(resolved.params[0]).toBe(`Template Mapping ${stamp}`);
    // The *label*, not the stored value: a picklist stores one string and
    // shows another, and the customer must read the one the screen shows.
    expect(resolved.params[1]).toBeTruthy();
    expect(resolved.params[2]).toBe('Shikha Jha');
    expect(resolved.params[3]).toBe('iPropy Realty');
    expect(resolved.preview).toContain(`Hello Template Mapping ${stamp}`);
  });

  it('names an empty field rather than sending a gap', async () => {
    await saveMapping(templateId, 'leads', {
      1: 'field:full_name',
      2: 'field:email',
      3: 'agent:name',
      4: 'org:name',
    });

    const resolved = await resolveTemplate({
      ctx, templateId, module: 'leads', recordId, agentName: 'A', orgName: 'B',
    });

    expect(resolved.missing).toHaveLength(1);
    expect(resolved.missing[0]).toMatchObject({ slot: '2' });
    expect(resolved.missing[0].reason).toMatch(/empty on this record/);
  });

  it('keeps the mapping when the provider\'s wording is synced again', async () => {
    await saveMapping(templateId, 'leads', { 1: 'field:full_name' });

    // What a sync does to an existing row: wording, category and status, and
    // deliberately not `variable_map`.
    await db.query(
      `INSERT INTO ipy_whatsapp_template (name, language, category, status, body_text)
       VALUES ($1, 'en', 'MARKETING', 'APPROVED', 'Hello {{1}}, new wording.')
       ON CONFLICT (name, language) DO UPDATE
         SET category = EXCLUDED.category, status = EXCLUDED.status, body_text = EXCLUDED.body_text`,
      [NAME],
    );

    const row = await db.queryOne<{ body_text: string; variable_map: Record<string, string> }>(
      `SELECT body_text, variable_map FROM ipy_whatsapp_template WHERE name = $1`, [NAME],
    );
    expect(row!.body_text).toBe('Hello {{1}}, new wording.');
    expect(row!.variable_map, 'a sync must never empty somebody\'s mapping').toMatchObject({
      1: 'field:full_name',
    });
  });
});
