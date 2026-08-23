/**
 * The seed must not undo an administrator's work.
 *
 * This is a regression suite for a bug that was live in production: the seed
 * rewrote (and in the case of dashboard widgets and workflow tasks, DELETEd and
 * rebuilt) rows an admin edits in the UI. Because docker-entrypoint.sh re-seeds
 * on every deploy *and* every cold start — and a free-tier Render instance cold
 * starts whenever it has been idle fifteen minutes — customised dashboards were
 * being reset to factory several times a day, and workflows an admin had
 * switched off turned themselves back on and resumed messaging customers.
 *
 * Every test here follows the same shape: edit something the way the UI would,
 * re-run the real seed, assert the edit survived. They would all have failed
 * before migration 033.
 *
 * The suite restores what it changes, because `fileParallelism: false` means
 * later files see this database.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

async function reseed(): Promise<void> {
  const { seed } = await import('../../src/db/seed/index.js');
  await seed();
}

describe('seed preserves admin customisation', () => {
  beforeAll(async () => {
    // Fail loudly here rather than in a confusing way below if the migration
    // that introduced the flag has not been applied.
    const col = await db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM information_schema.columns
        WHERE table_name = 'ipy_field' AND column_name = 'is_customised'`,
    );
    expect(col, 'migration 033 must have run').toBeTruthy();
  });

  it('keeps a widget added to a system dashboard', async () => {
    const dash = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_dashboard WHERE is_system = true ORDER BY sequence LIMIT 1`,
    );
    expect(dash).toBeTruthy();

    const before = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_dashboard_widget WHERE dashboard_id = $1`, [dash!.id],
    );

    const added = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_dashboard_widget (dashboard_id, type, title, x, y, w, h, config, sequence)
       VALUES ($1,'metric','Admin added me',0,99,3,2,'{}'::jsonb,99) RETURNING id`,
      [dash!.id],
    );

    await reseed();

    const survived = await db.queryOne<{ title: string }>(
      `SELECT title FROM ipy_dashboard_widget WHERE id = $1`, [added!.id],
    );
    expect(survived?.title, 'widget was deleted by the seed').toBe('Admin added me');

    // and the seeded widgets were not duplicated alongside it
    const after = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_dashboard_widget WHERE dashboard_id = $1`, [dash!.id],
    );
    expect(after!.count).toBe(before!.count + 1);

    await db.query(`DELETE FROM ipy_dashboard_widget WHERE id = $1`, [added!.id]);
  });

  it('leaves a disabled workflow disabled, and does not resurrect a deleted task', async () => {
    const wf = await db.queryOne<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM ipy_workflow WHERE is_system = true ORDER BY sequence LIMIT 1`,
    );
    expect(wf).toBeTruthy();

    const task = await db.queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM ipy_workflow_task WHERE workflow_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [wf!.id],
    );
    expect(task, 'seeded workflow should have tasks to begin with').toBeTruthy();

    await db.query(`UPDATE ipy_workflow SET is_active = false WHERE id = $1`, [wf!.id]);
    await db.query(`DELETE FROM ipy_workflow_task WHERE id = $1`, [task!.id]);

    await reseed();

    const after = await db.queryOne<{ is_active: boolean }>(
      `SELECT is_active FROM ipy_workflow WHERE id = $1`, [wf!.id],
    );
    expect(after?.is_active, 'a workflow the admin switched off was re-enabled').toBe(false);

    const resurrected = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_workflow_task WHERE workflow_id = $1 AND name = $2`,
      [wf!.id, task!.name],
    );
    expect(resurrected, 'a deleted workflow task came back').toBeFalsy();

    await db.query(`UPDATE ipy_workflow SET is_active = $2 WHERE id = $1`, [wf!.id, wf!.is_active]);
  });

  it('keeps an edited field\'s label and config once the field editor has claimed it', async () => {
    const field = await db.queryOne<{ id: string; label: string; config: Record<string, unknown> }>(
      `SELECT f.id, f.label, f.config FROM ipy_field f
         JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.storage = 'column' AND f.is_customised = false
        ORDER BY f.sequence LIMIT 1`,
    );
    expect(field).toBeTruthy();

    // Exactly what PUT /api/meta/fields/:id does.
    await db.query(
      `UPDATE ipy_field SET label = $2, config = $3::jsonb, is_customised = true WHERE id = $1`,
      [field!.id, 'Renamed By Admin', JSON.stringify({ ...field!.config, visibleWhen: { field: 'status', operator: 'equals', value: 'New' } })],
    );

    await reseed();

    const after = await db.queryOne<{ label: string; config: Record<string, unknown>; storage: string }>(
      `SELECT label, config, storage FROM ipy_field WHERE id = $1`, [field!.id],
    );
    expect(after?.label, 'the seed relabelled a field the admin had renamed').toBe('Renamed By Admin');
    expect(after?.config?.visibleWhen, 'the seed wiped an admin-authored visibility rule').toBeTruthy();
    // Plumbing must still be maintained even on a customised field, or the
    // query builder ends up looking for the value in the wrong place.
    expect(after?.storage).toBe('column');

    await db.query(
      `UPDATE ipy_field SET label = $2, config = $3::jsonb, is_customised = false WHERE id = $1`,
      [field!.id, field!.label, JSON.stringify(field!.config)],
    );
    registry.invalidate();
  });

  it('still refreshes a field the admin has never touched', async () => {
    // The mirror of the test above: create-only must not mean the seed stops
    // being able to correct its own metadata on an untouched field.
    const field = await db.queryOne<{ id: string; label: string }>(
      `SELECT f.id, f.label FROM ipy_field f
         JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.is_customised = false
        ORDER BY f.sequence LIMIT 1`,
    );
    await db.query(`UPDATE ipy_field SET label = 'Drifted' WHERE id = $1`, [field!.id]);

    await reseed();

    const after = await db.queryOne<{ label: string }>(`SELECT label FROM ipy_field WHERE id = $1`, [field!.id]);
    expect(after?.label, 'an untouched field should still be refreshed from the template').toBe(field!.label);
    registry.invalidate();
  });

  it('does not resurrect a deleted section', async () => {
    // The last part of the model the seed still owned outright. It upserts
    // every section on every cold start, so one deleted in the admin panel came
    // back within the hour and the panel had no way to say so. Migration 066
    // gave sections the tombstone the rest of the model already had; migration
    // 072 cleared the ones already stranded on his database.
    const block = await db.queryOne<{ id: string; name: string; label: string; module_id: string }>(
      `SELECT b.id, b.name, b.label, b.module_id
         FROM ipy_block b JOIN ipy_module m ON m.id = b.module_id
        WHERE m.name = 'leads'
          AND NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.block_id = b.id)
        LIMIT 1`,
    );
    // Every empty section is gone from a migrated database, which is the point
    // of 072, so make one to delete rather than depending on one being left.
    const target = block ?? await db.queryOne<{ id: string; name: string; label: string; module_id: string }>(
      `INSERT INTO ipy_block (module_id, name, label)
       SELECT id, 'temp_seed_probe', 'Temporary' FROM ipy_module WHERE name = 'leads'
       RETURNING id, name, label, module_id`,
    );
    expect(target).toBeTruthy();

    await db.query(
      `INSERT INTO ipy_block_tombstone (module_name, block_name, label) VALUES ('leads', $1, $2)
       ON CONFLICT (module_name, block_name) DO NOTHING`,
      [target!.name, target!.label],
    );
    await db.query(`DELETE FROM ipy_block WHERE id = $1`, [target!.id]);

    await reseed();

    const back = await db.queryOne<{ id: string }>(
      `SELECT b.id FROM ipy_block b JOIN ipy_module m ON m.id = b.module_id
        WHERE m.name = 'leads' AND b.name = $1`,
      [target!.name],
    );
    expect(back, `the seed rebuilt the deleted section "${target!.name}"`).toBeNull();

    // And the layout must not still name it. This was the half that was
    // missing: the section stayed deleted, and every re-seed wrote its key back
    // into the layout config, so the Layout Designer went on showing a section
    // that no longer existed anywhere else.
    const naming = await db.query<{ name: string }>(
      `SELECT l.name FROM ipy_layout l
         JOIN ipy_module m ON m.id = l.module_id,
         LATERAL jsonb_array_elements(l.config -> 'blocks') AS b
        WHERE m.name = 'leads'
          AND jsonb_typeof(l.config -> 'blocks') = 'array'
          AND b ->> 'key' = $1`,
      [target!.name],
    );
    expect(
      naming.rows.map((r) => r.name),
      'these layouts still name a section that has been deleted',
    ).toEqual([]);

    await db.query(`DELETE FROM ipy_block_tombstone WHERE module_name = 'leads' AND block_name = $1`, [target!.name]);
  });

  it('leaves no section standing with nothing in it', async () => {
    // What he actually reported was not "KYC exists", it was a heading on the
    // lead screen with nothing under it. That is what a section looks like once
    // its last field has been deleted, and deleting the fields is a thing an
    // admin does all the time.
    //
    // Asserting the empty *heading* rather than the two names he happened to
    // mention is deliberate. The names are true of his database and not of a
    // fresh one, where the seed creates both sections with their fields intact
    // and they are perfectly legitimate. The rule that holds everywhere is that
    // a section with no fields should not be on screen.
    const empty = await db.query<{ module_name: string; name: string }>(
      `SELECT m.name AS module_name, b.name
         FROM ipy_block b
         JOIN ipy_module m ON m.id = b.module_id
        WHERE NOT EXISTS (SELECT 1 FROM ipy_field f WHERE f.block_id = b.id)
        ORDER BY m.name, b.name`,
    );
    expect(
      empty.rows.map((r) => `${r.module_name}.${r.name}`),
      'these sections would render as a heading with nothing under it',
    ).toEqual([]);
  });

  it('keeps a renamed picklist value', async () => {
    const value = await db.queryOne<{ id: string; label: string }>(
      `SELECT pv.id, pv.label FROM ipy_picklist_value pv
         JOIN ipy_picklist p ON p.id = pv.picklist_id
        WHERE p.name = 'lead_status' ORDER BY pv.sequence LIMIT 1`,
    );
    expect(value).toBeTruthy();

    await db.query(`UPDATE ipy_picklist_value SET label = 'Fresh Enquiry' WHERE id = $1`, [value!.id]);
    await reseed();

    const after = await db.queryOne<{ label: string }>(
      `SELECT label FROM ipy_picklist_value WHERE id = $1`, [value!.id],
    );
    expect(after?.label, 'the seed undid a renamed dropdown value').toBe('Fresh Enquiry');

    await db.query(`UPDATE ipy_picklist_value SET label = $2 WHERE id = $1`, [value!.id, value!.label]);
  });

  it('keeps an edited system view', async () => {
    const view = await db.queryOne<{ id: string; columns: string[] }>(
      `SELECT id, columns FROM ipy_view WHERE is_system = true ORDER BY sequence LIMIT 1`,
    );
    expect(view).toBeTruthy();

    await db.query(`UPDATE ipy_view SET columns = $2::jsonb WHERE id = $1`, [view!.id, JSON.stringify(['first_name'])]);
    await reseed();

    const after = await db.queryOne<{ columns: string[] }>(`SELECT columns FROM ipy_view WHERE id = $1`, [view!.id]);
    expect(after?.columns, 'the seed reset a view the admin had rearranged').toEqual(['first_name']);

    await db.query(`UPDATE ipy_view SET columns = $2::jsonb WHERE id = $1`, [view!.id, JSON.stringify(view!.columns)]);
  });

  it('keeps rewritten message templates', async () => {
    const original = await db.queryOne<{ body_text: string }>(
      `SELECT body_text FROM ipy_whatsapp_template WHERE name = 'lead_welcome' AND language = 'en'`,
    );
    expect(original).toBeTruthy();

    await db.query(
      `UPDATE ipy_whatsapp_template SET body_text = $1 WHERE name = 'lead_welcome' AND language = 'en'`,
      ['Our own wording, approved by Meta'],
    );
    await reseed();

    const after = await db.queryOne<{ body_text: string }>(
      `SELECT body_text FROM ipy_whatsapp_template WHERE name = 'lead_welcome' AND language = 'en'`,
    );
    expect(after?.body_text, 'the seed overwrote an approved template body').toBe('Our own wording, approved by Meta');

    await db.query(
      `UPDATE ipy_whatsapp_template SET body_text = $1 WHERE name = 'lead_welcome' AND language = 'en'`,
      [original!.body_text],
    );
  });

  it('does not hand back permissions an admin removed', async () => {
    const perm = await db.queryOne<{ profile_id: string; module_id: string; can_delete: boolean }>(
      `SELECT profile_id, module_id, can_delete FROM ipy_profile_module_perm WHERE can_delete = true LIMIT 1`,
    );
    expect(perm).toBeTruthy();

    await db.query(
      `UPDATE ipy_profile_module_perm SET can_delete = false WHERE profile_id = $1 AND module_id = $2`,
      [perm!.profile_id, perm!.module_id],
    );
    await reseed();

    const after = await db.queryOne<{ can_delete: boolean }>(
      `SELECT can_delete FROM ipy_profile_module_perm WHERE profile_id = $1 AND module_id = $2`,
      [perm!.profile_id, perm!.module_id],
    );
    expect(after?.can_delete, 'the seed restored a permission the admin revoked').toBe(false);

    await db.query(
      `UPDATE ipy_profile_module_perm SET can_delete = true WHERE profile_id = $1 AND module_id = $2`,
      [perm!.profile_id, perm!.module_id],
    );
  });

  it('still creates something that is genuinely missing', async () => {
    // Create-only has to keep meaning "creates" — otherwise a new dashboard or
    // picklist value added to a template would never reach an existing install.
    const value = await db.queryOne<{ id: string; picklist_id: string; value: string; label: string; sequence: number }>(
      `SELECT pv.id, pv.picklist_id, pv.value, pv.label, pv.sequence FROM ipy_picklist_value pv
         JOIN ipy_picklist p ON p.id = pv.picklist_id
        WHERE p.name = 'lead_status' ORDER BY pv.sequence DESC LIMIT 1`,
    );
    await db.query(`DELETE FROM ipy_picklist_value WHERE id = $1`, [value!.id]);

    await reseed();

    const restored = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_picklist_value WHERE picklist_id = $1 AND value = $2`,
      [value!.picklist_id, value!.value],
    );
    expect(restored, 'the seed should still add a value that is missing').toBeTruthy();
  });
});
