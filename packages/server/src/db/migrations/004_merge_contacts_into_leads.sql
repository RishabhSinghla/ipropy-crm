-- ===========================================================================
-- iPropy CRM — 004: merge Contacts into Leads
--
-- A separate Contacts module duplicates the person record: the same human
-- exists twice, conversion copies fields between them, and the timeline splits
-- across two ids. Leads becomes the single party record, carrying a
-- lifecycle_stage from first enquiry through to past customer.
--
-- This works cleanly because every `contact_id` in the schema references
-- ipy_record(id), not ipy_e_contacts. Moving a record between modules keeps
-- every foreign key intact — no repointing required.
--
-- Safe to run on a fresh database (everything is guarded) and idempotent.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Widen ipy_e_leads to hold everything a contact carried
-- ---------------------------------------------------------------------------

ALTER TABLE ipy_e_leads
  -- lifecycle: where this person sits between enquiry and past customer
  ADD COLUMN IF NOT EXISTS lifecycle_stage    TEXT NOT NULL DEFAULT 'Lead',
  ADD COLUMN IF NOT EXISTS contact_type       TEXT,
  ADD COLUMN IF NOT EXISTS organization_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS secondary_email    TEXT,
  -- personal
  ADD COLUMN IF NOT EXISTS date_of_birth      DATE,
  ADD COLUMN IF NOT EXISTS anniversary        DATE,
  ADD COLUMN IF NOT EXISTS gender             TEXT,
  ADD COLUMN IF NOT EXISTS occupation         TEXT,
  ADD COLUMN IF NOT EXISTS annual_income      NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS nationality        TEXT,
  ADD COLUMN IF NOT EXISTS is_nri             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS preferred_language TEXT,
  ADD COLUMN IF NOT EXISTS preferred_contact  TEXT,
  ADD COLUMN IF NOT EXISTS portrait_url       TEXT,
  -- consent
  ADD COLUMN IF NOT EXISTS do_not_call        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_whatsapp    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_opt_out      BOOLEAN NOT NULL DEFAULT false,
  -- KYC
  ADD COLUMN IF NOT EXISTS pan                TEXT,
  ADD COLUMN IF NOT EXISTS aadhaar_masked     TEXT,
  ADD COLUMN IF NOT EXISTS passport_number    TEXT,
  ADD COLUMN IF NOT EXISTS kyc_status         TEXT,
  -- relationship value
  ADD COLUMN IF NOT EXISTS engagement_score   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
  -- free-form requirement captured by the AI assistant
  ADD COLUMN IF NOT EXISTS requirement        JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_lead_lifecycle ON ipy_e_leads(lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_lead_org ON ipy_e_leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_lead_type ON ipy_e_leads(contact_type);

-- ---------------------------------------------------------------------------
-- 2. Move contact rows into leads, preserving record_id
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  leads_module_id UUID;
  contacts_module_id UUID;
  moved INT := 0;
BEGIN
  SELECT id INTO leads_module_id FROM ipy_module WHERE name = 'leads';
  SELECT id INTO contacts_module_id FROM ipy_module WHERE name = 'contacts';

  -- Fresh install: nothing to migrate.
  IF contacts_module_id IS NULL OR leads_module_id IS NULL THEN
    RAISE NOTICE 'contacts module not present — nothing to migrate';
    RETURN;
  END IF;

  -- Copy the payload across. A contact that somehow already has a lead row
  -- (shouldn't happen, but be safe) is skipped rather than overwritten.
  INSERT INTO ipy_e_leads (
    record_id, salutation, first_name, last_name, email, secondary_email,
    mobile, alternate_phone, whatsapp_number, company, designation,
    status, lifecycle_stage, contact_type, organization_id, lead_source,
    budget_min, budget_max, preferred_locations, configuration, purpose,
    funding_type, possession_timeline, address, requirement,
    date_of_birth, anniversary, gender, occupation, annual_income, nationality,
    is_nri, preferred_language, preferred_contact, portrait_url,
    do_not_call, do_not_whatsapp, email_opt_out,
    pan, aadhaar_masked, passport_number, kyc_status,
    engagement_score, lifetime_value, description, custom_fields
  )
  SELECT
    c.record_id, c.salutation, c.first_name, c.last_name, c.email, c.secondary_email,
    c.mobile, c.phone, c.whatsapp_number, c.company_name, c.designation,
    -- A migrated contact is past the enquiry pipeline.
    'Converted',
    CASE
      WHEN EXISTS (SELECT 1 FROM ipy_e_bookings b WHERE b.contact_id = c.record_id) THEN 'Customer'
      ELSE 'Prospect'
    END,
    c.contact_type, c.organization_id, c.lead_source,
    c.budget_min, c.budget_max, c.preferred_locations, c.preferred_config, c.purpose,
    c.funding_type, c.purchase_timeline, c.mailing_address, c.requirement,
    c.date_of_birth, c.anniversary, c.gender, c.occupation, c.annual_income, c.nationality,
    c.is_nri, c.preferred_language, c.preferred_contact, c.portrait_url,
    c.do_not_call, c.do_not_whatsapp, c.email_opt_out,
    c.pan, c.aadhaar_masked, c.passport_number, c.kyc_status,
    c.engagement_score, c.lifetime_value, c.description, c.custom_fields
  FROM ipy_e_contacts c
  WHERE NOT EXISTS (SELECT 1 FROM ipy_e_leads l WHERE l.record_id = c.record_id);

  GET DIAGNOSTICS moved = ROW_COUNT;

  -- Re-home the record rows. Every FK targets ipy_record(id), so this single
  -- update is what makes deals, bookings, payments and conversations follow.
  UPDATE ipy_record
  SET module_id = leads_module_id, module_name = 'leads'
  WHERE module_id = contacts_module_id;

  -- A lead that had been converted now *is* the contact.
  UPDATE ipy_e_leads SET converted_contact_id = NULL WHERE converted_contact_id IS NOT NULL;

  UPDATE ipy_call SET record_module = 'leads' WHERE record_module = 'contacts';
  UPDATE ipy_conversation SET record_module = 'leads' WHERE record_module = 'contacts';
  UPDATE ipy_e_activities SET related_module = 'leads' WHERE related_module = 'contacts';
  UPDATE ipy_e_documents SET related_module = 'leads' WHERE related_module = 'contacts';
  UPDATE ipy_audit SET module_name = 'leads' WHERE module_name = 'contacts';
  UPDATE ipy_ai_insight SET module_name = 'leads' WHERE module_name = 'contacts';

  RAISE NOTICE 'merged % contacts into leads', moved;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Repoint metadata: any lookup that targeted contacts now targets leads
-- ---------------------------------------------------------------------------

UPDATE ipy_field
SET config = jsonb_set(
      config,
      '{referenceModules}',
      (
        SELECT COALESCE(jsonb_agg(DISTINCT CASE WHEN v = '"contacts"'::jsonb THEN '"leads"'::jsonb ELSE v END), '[]'::jsonb)
        FROM jsonb_array_elements(config->'referenceModules') AS v
      )
    )
WHERE config->'referenceModules' @> '"contacts"'::jsonb;

-- Related lists that pointed at contacts now point at leads.
UPDATE ipy_relation
SET target_module_id = (SELECT id FROM ipy_module WHERE name = 'leads')
WHERE target_module_id = (SELECT id FROM ipy_module WHERE name = 'contacts')
  AND EXISTS (SELECT 1 FROM ipy_module WHERE name = 'leads');

-- The Organisation → Contacts related list becomes Organisation → Leads.
UPDATE ipy_relation SET name = 'org_leads', label = 'Leads & Customers'
WHERE name = 'org_contacts';

-- ---------------------------------------------------------------------------
-- 4. Retire the contacts module
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  contacts_module_id UUID;
BEGIN
  SELECT id INTO contacts_module_id FROM ipy_module WHERE name = 'contacts';
  IF contacts_module_id IS NULL THEN RETURN; END IF;

  -- Relations, views, layouts, fields and permissions cascade from the module row.
  DELETE FROM ipy_module WHERE id = contacts_module_id;

  -- The payload table is kept, renamed, so the original rows remain
  -- recoverable. Drop it manually once you are satisfied with the merge.
  ALTER TABLE IF EXISTS ipy_e_contacts RENAME TO ipy_e_contacts_archived_004;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Module enable/disable support
-- ---------------------------------------------------------------------------

-- Records already carry is_active; this makes the intent explicit and lets the
-- admin UI explain *why* a module is off.
ALTER TABLE ipy_module
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT,
  ADD COLUMN IF NOT EXISTS disabled_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disabled_by     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- Core modules cannot be disabled: the app depends on them structurally.
  ADD COLUMN IF NOT EXISTS is_core         BOOLEAN NOT NULL DEFAULT false;

UPDATE ipy_module SET is_core = true WHERE name IN ('leads', 'activities');
