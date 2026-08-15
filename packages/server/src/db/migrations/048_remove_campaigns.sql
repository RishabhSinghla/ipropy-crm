-- ===========================================================================
-- iPropy CRM — 048: Campaigns removed for good
--
-- 031 left three modules standing. Campaigns is now gone too, leaving two:
--
--   Leads & Contacts   — the person, with their calls, notes and timeline
--   Properties         — units, each carrying its development's name itself
--
-- The module was never worked. What a marketer actually does here happens in
-- Outreach (broadcasts and sequences) and in the source/UTM fields on the lead
-- itself, which is where the attribution question — "where did this enquiry come
-- from?" — is answered. A campaign record in between was a second place to keep
-- the same answer up to date, and nobody did.
--
-- **This deletes records.** Only demo data existed at the time of writing; the
-- payload rows are copied to `ipy_e_campaigns_archive` first anyway, as 031 did,
-- because the copy costs nothing and a wrong call costs a restore. Nothing in
-- the application reads that table — drop it by hand once you are sure.
--
-- Order matters, as in 030 and 031: cross-module references first, then records
-- through `ipy_record` so payload rows cascade, then metadata, then tables.
--
-- What is deliberately kept:
--
--   * `utm_source` / `utm_medium` / `utm_campaign` / `gclid` / `fbclid` on the
--     lead. These are the attribution keys themselves — free text arriving with
--     the enquiry — not a pointer at a campaign record.
--   * Outreach broadcasts (`ipy_broadcast`) and sequences. A broadcast is a send,
--     not a campaign record; only its optional link *to* one goes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Cross-module references, before their target disappears
--
-- A reference field pointing at a module that no longer exists renders a
-- permanently broken lookup.
-- ---------------------------------------------------------------------------

DELETE FROM ipy_field
WHERE name = 'campaign_id'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'leads');

ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS campaign_id;

-- Everything else that pointed a row at a campaign record. Each is an optional
-- attribution link, so dropping the column loses the link and nothing else: the
-- message, the tracked number and the broadcast all stand on their own.
ALTER TABLE ipy_message        DROP COLUMN IF EXISTS campaign_id;
ALTER TABLE ipy_virtual_number DROP COLUMN IF EXISTS campaign_id;
ALTER TABLE ipy_broadcast      DROP COLUMN IF EXISTS campaign_id;

-- A web form could force a campaign onto every submission it created.
UPDATE ipy_webform SET defaults = defaults - 'campaign_id'
WHERE defaults ? 'campaign_id';

-- ---------------------------------------------------------------------------
-- 2. Archive, then delete the records
--
-- Through `ipy_record` so attachments, comments, audit rows and timeline
-- entries cascade rather than being orphaned by a bare DROP TABLE.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ipy_e_campaigns_archive AS TABLE ipy_e_campaigns;

DELETE FROM ipy_record WHERE module_name = 'campaigns';

-- ---------------------------------------------------------------------------
-- 3. Metadata
--
-- Fields, blocks, views, layouts, profile permissions and sharing rules are all
-- FK'd to the module with ON DELETE CASCADE, so deleting the module row takes
-- the lot. Relations are the exception — they name two modules, and one of them
-- survives.
-- ---------------------------------------------------------------------------

DELETE FROM ipy_relation
WHERE source_module_id IN (SELECT id FROM ipy_module WHERE name = 'campaigns')
   OR target_module_id IN (SELECT id FROM ipy_module WHERE name = 'campaigns');

DELETE FROM ipy_module WHERE name = 'campaigns';

DROP TABLE IF EXISTS ipy_e_campaigns;

-- ---------------------------------------------------------------------------
-- 4. Anything still pointing at it
-- ---------------------------------------------------------------------------

-- Widgets reading a module that no longer exists. The Marketing Performance
-- dashboard keeps its four lead-side widgets; only the three campaign ones go.
DELETE FROM ipy_dashboard_widget WHERE config->>'module' = 'campaigns';

DELETE FROM ipy_dashboard d
WHERE NOT EXISTS (SELECT 1 FROM ipy_dashboard_widget w WHERE w.dashboard_id = d.id)
  AND d.is_system = true;

-- `ipy_workflow` keys on `module_id` and the module row is already gone, so this
-- has to catch the orphans rather than match on a name.
DELETE FROM ipy_workflow w
WHERE NOT EXISTS (SELECT 1 FROM ipy_module m WHERE m.id = w.module_id);

-- Saved views and layouts naming a column that no longer exists would render a
-- blank cell or an empty section, so strip the name out rather than leaving it
-- to fail quietly.
UPDATE ipy_view
SET columns = COALESCE((
      SELECT jsonb_agg(c) FROM jsonb_array_elements_text(columns) AS c WHERE c <> 'campaign_id'
    ), '[]'::jsonb)
WHERE columns ? 'campaign_id';

UPDATE ipy_layout
SET config = jsonb_set(
      config,
      '{blocks}',
      COALESCE((
        SELECT jsonb_agg(
                 b || jsonb_build_object('fields', COALESCE((
                   SELECT jsonb_agg(f) FROM jsonb_array_elements_text(b->'fields') AS f
                   WHERE f <> 'campaign_id'
                 ), '[]'::jsonb))
               )
        FROM jsonb_array_elements(config->'blocks') AS b
      ), '[]'::jsonb)
    )
WHERE config ? 'blocks';

UPDATE ipy_layout
SET config = config || jsonb_build_object('headerFields', COALESCE((
      SELECT jsonb_agg(h) FROM jsonb_array_elements_text(config->'headerFields') AS h
      WHERE h <> 'campaign_id'
    ), '[]'::jsonb))
WHERE config ? 'headerFields';

-- ---------------------------------------------------------------------------
-- 5. The two dropdowns that existed only for this module
--
-- Values cascade from `ipy_picklist`. Both are gone from `db/seed/picklists.ts`
-- in the same commit, which is what stops the next cold start recreating them.
-- ---------------------------------------------------------------------------

DELETE FROM ipy_picklist WHERE name IN ('campaign_type', 'campaign_status');
