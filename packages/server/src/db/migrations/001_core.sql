-- ===========================================================================
-- iPropy CRM — 001 core: metadata engine, identity, records
--
-- Design notes
-- ------------
-- The metadata engine follows Vtiger's proven split (vtiger_tab / vtiger_blocks
-- / vtiger_field) but modernised:
--   * modules, blocks and fields are rows, so admins reshape the CRM at runtime
--   * every entity record gets a row in ipy_record (Vtiger's vtiger_crmentity)
--     giving one id space for ownership, audit, comments, tags, attachments and
--     polymorphic relations
--   * per-module payload tables hold declared columns for hot fields, plus a
--     custom_fields JSONB for anything an admin adds — no ALTER TABLE at runtime
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_role (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  parent_id     UUID REFERENCES ipy_role(id) ON DELETE SET NULL,
  depth         INT NOT NULL DEFAULT 0,
  -- materialised ancestor path enables "role and subordinates" scoping in one query
  path          UUID[] NOT NULL DEFAULT '{}',
  description   TEXT,
  sequence      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_role_parent ON ipy_role(parent_id);
CREATE INDEX idx_role_path ON ipy_role USING GIN(path);

CREATE TABLE ipy_profile (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  capabilities  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_user (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT NOT NULL,
  password_hash         TEXT,
  first_name            TEXT NOT NULL DEFAULT '',
  last_name             TEXT NOT NULL DEFAULT '',
  phone                 TEXT,
  avatar_url            TEXT,
  designation           TEXT,
  department            TEXT,
  is_admin              BOOLEAN NOT NULL DEFAULT false,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  role_id               UUID REFERENCES ipy_role(id) ON DELETE SET NULL,
  profile_id            UUID REFERENCES ipy_profile(id) ON DELETE SET NULL,
  reports_to            UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  timezone              TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  locale                TEXT NOT NULL DEFAULT 'en-IN',
  currency              TEXT NOT NULL DEFAULT 'INR',
  theme                 TEXT NOT NULL DEFAULT 'system',
  -- telephony agent extension / caller id for click-to-call
  extension             TEXT,
  telephony_number      TEXT,
  default_dashboard_id  UUID,
  -- round-robin lead assignment participation
  accepts_leads         BOOLEAN NOT NULL DEFAULT true,
  daily_lead_cap        INT,
  preferences           JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_login_at         TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_user_email ON ipy_user(lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX idx_user_role ON ipy_user(role_id);
CREATE INDEX idx_user_active ON ipy_user(is_active) WHERE deleted_at IS NULL;

CREATE TABLE ipy_group (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  -- e.g. a project sales team, or the "Inside Sales" pod
  kind          TEXT NOT NULL DEFAULT 'team',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_group_member (
  group_id      UUID NOT NULL REFERENCES ipy_group(id) ON DELETE CASCADE,
  member_type   TEXT NOT NULL CHECK (member_type IN ('user','role','role_subordinates','group')),
  member_id     UUID NOT NULL,
  PRIMARY KEY (group_id, member_type, member_id)
);

CREATE TABLE ipy_session (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip_address    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_user ON ipy_session(user_id);
CREATE INDEX idx_session_token ON ipy_session(refresh_token);

-- ---------------------------------------------------------------------------
-- Metadata engine
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_module (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL UNIQUE,        -- machine name: 'leads'
  label                   TEXT NOT NULL,               -- plural label: 'Leads'
  singular_label          TEXT NOT NULL,
  table_name              TEXT NOT NULL,               -- payload table: 'ipy_e_leads'
  icon                    TEXT NOT NULL DEFAULT 'box',
  color                   TEXT NOT NULL DEFAULT '#3b82f6',
  sequence                INT NOT NULL DEFAULT 0,
  -- entity modules own records; non-entity modules are tool screens (Inbox, Reports)
  is_entity               BOOLEAN NOT NULL DEFAULT true,
  is_custom               BOOLEAN NOT NULL DEFAULT false,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  show_in_menu            BOOLEAN NOT NULL DEFAULT true,
  menu_group              TEXT NOT NULL DEFAULT 'CRM',
  -- fields concatenated to build ipy_record.label
  label_fields            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- picklist field that powers the kanban pipeline, if any
  pipeline_field          TEXT,
  duplicate_check_fields  JSONB NOT NULL DEFAULT '[]'::jsonb,
  supports_comments       BOOLEAN NOT NULL DEFAULT true,
  supports_attachments    BOOLEAN NOT NULL DEFAULT true,
  supports_workflow       BOOLEAN NOT NULL DEFAULT true,
  supports_tags           BOOLEAN NOT NULL DEFAULT true,
  supports_conversion     BOOLEAN NOT NULL DEFAULT false,
  settings                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_module_active ON ipy_module(is_active, sequence);

CREATE TABLE ipy_block (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  label         TEXT NOT NULL,
  sequence      INT NOT NULL DEFAULT 0,
  is_collapsed  BOOLEAN NOT NULL DEFAULT false,
  columns       INT NOT NULL DEFAULT 2,
  is_custom     BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  visible_when  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, name)
);
CREATE INDEX idx_block_module ON ipy_block(module_id, sequence);

CREATE TABLE ipy_field (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  block_id      UUID REFERENCES ipy_block(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,                       -- machine name
  label         TEXT NOT NULL,
  uitype        TEXT NOT NULL,
  -- 'column' → real column on the payload table; 'json' → key in custom_fields
  storage       TEXT NOT NULL DEFAULT 'json' CHECK (storage IN ('column','json')),
  column_name   TEXT NOT NULL,
  sequence      INT NOT NULL DEFAULT 0,
  is_mandatory  BOOLEAN NOT NULL DEFAULT false,
  is_readonly   BOOLEAN NOT NULL DEFAULT false,
  is_unique     BOOLEAN NOT NULL DEFAULT false,
  is_custom     BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  display_type  TEXT NOT NULL DEFAULT 'default'
                CHECK (display_type IN ('default','readonly','hidden','detail_only','create_only')),
  default_value JSONB,
  max_length    INT,
  help_text     TEXT,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  quick_create  BOOLEAN NOT NULL DEFAULT false,
  mass_editable BOOLEAN NOT NULL DEFAULT true,
  searchable    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, name)
);
CREATE INDEX idx_field_module ON ipy_field(module_id, sequence);
CREATE INDEX idx_field_block ON ipy_field(block_id);
CREATE INDEX idx_field_uitype ON ipy_field(uitype);

-- Picklists are first-class so the same option set can be reused across modules
CREATE TABLE ipy_picklist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  module_id     UUID REFERENCES ipy_module(id) ON DELETE CASCADE,  -- NULL = global
  is_global     BOOLEAN NOT NULL DEFAULT false,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  -- non-admins may add values on the fly when true
  allow_adhoc   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_picklist_value (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  picklist_id   UUID NOT NULL REFERENCES ipy_picklist(id) ON DELETE CASCADE,
  value         TEXT NOT NULL,
  label         TEXT NOT NULL,
  color         TEXT,
  sequence      INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  -- arbitrary extras: deal-stage probability, status "closed" flags, etc.
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (picklist_id, value)
);
CREATE INDEX idx_plv_picklist ON ipy_picklist_value(picklist_id, sequence);

-- Cascading dropdowns: choosing City filters the Locality picklist
CREATE TABLE ipy_picklist_dependency (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  source_field      TEXT NOT NULL,
  target_field      TEXT NOT NULL,
  -- { "Bengaluru": ["Whitefield","Indiranagar"], ... }
  mapping           JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (module_id, source_field, target_field)
);

-- Role-based picklist value visibility (Vtiger's vtiger_role2picklist)
CREATE TABLE ipy_picklist_role_access (
  picklist_value_id UUID NOT NULL REFERENCES ipy_picklist_value(id) ON DELETE CASCADE,
  role_id           UUID NOT NULL REFERENCES ipy_role(id) ON DELETE CASCADE,
  PRIMARY KEY (picklist_value_id, role_id)
);

CREATE TABLE ipy_relation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  label             TEXT NOT NULL,
  source_module_id  UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  target_module_id  UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('one_to_many','many_to_many','many_to_one')),
  -- for one_to_many: the reference field on the target module pointing back
  foreign_field     TEXT,
  sequence          INT NOT NULL DEFAULT 0,
  actions           JSONB NOT NULL DEFAULT '["add","select","remove"]'::jsonb,
  columns           JSONB,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  is_custom         BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (source_module_id, name)
);
CREATE INDEX idx_relation_source ON ipy_relation(source_module_id, sequence);

-- Generic link table for many_to_many relations and ad-hoc record links
CREATE TABLE ipy_record_link (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id   UUID REFERENCES ipy_relation(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL,
  target_id     UUID NOT NULL,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (relation_id, source_id, target_id)
);
CREATE INDEX idx_link_source ON ipy_record_link(source_id);
CREATE INDEX idx_link_target ON ipy_record_link(target_id);

-- ---------------------------------------------------------------------------
-- Record base table (Vtiger's crmentity)
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_record (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  module_name   TEXT NOT NULL,
  record_number TEXT,
  label         TEXT NOT NULL DEFAULT '',
  owner_id      UUID,
  owner_type    TEXT NOT NULL DEFAULT 'user' CHECK (owner_type IN ('user','group')),
  created_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  modified_by   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted    BOOLEAN NOT NULL DEFAULT false,
  deleted_at    TIMESTAMPTZ,
  deleted_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- denormalised full-text haystack, refreshed by the record service on write
  search_text   TEXT NOT NULL DEFAULT '',
  search_vector TSVECTOR,
  -- last meaningful touch (call, message, meeting) — drives "going cold" logic
  last_activity_at TIMESTAMPTZ,
  source        TEXT NOT NULL DEFAULT 'app'
);
CREATE INDEX idx_record_module ON ipy_record(module_id) WHERE is_deleted = false;
CREATE INDEX idx_record_owner ON ipy_record(owner_id) WHERE is_deleted = false;
CREATE INDEX idx_record_created ON ipy_record(created_at DESC);
CREATE INDEX idx_record_updated ON ipy_record(updated_at DESC);
CREATE INDEX idx_record_number ON ipy_record(record_number);
CREATE INDEX idx_record_search ON ipy_record USING GIN(search_vector);
CREATE INDEX idx_record_label_trgm ON ipy_record USING GIN(label gin_trgm_ops);
CREATE INDEX idx_record_activity ON ipy_record(last_activity_at DESC NULLS LAST);

CREATE OR REPLACE FUNCTION ipy_record_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple',
    coalesce(NEW.label,'') || ' ' || coalesce(NEW.record_number,'') || ' ' || coalesce(NEW.search_text,''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_record_tsv BEFORE INSERT OR UPDATE OF label, record_number, search_text
  ON ipy_record FOR EACH ROW EXECUTE FUNCTION ipy_record_tsv();

-- Auto-number sequences, one row per (module, field)
CREATE TABLE ipy_sequence (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_name   TEXT NOT NULL,
  field_name    TEXT NOT NULL,
  prefix        TEXT NOT NULL DEFAULT '',
  suffix        TEXT NOT NULL DEFAULT '',
  digits        INT NOT NULL DEFAULT 5,
  current_value BIGINT NOT NULL DEFAULT 0,
  reset_policy  TEXT NOT NULL DEFAULT 'never' CHECK (reset_policy IN ('never','yearly','monthly')),
  reset_marker  TEXT,
  UNIQUE (module_name, field_name)
);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_profile_module_perm (
  profile_id    UUID NOT NULL REFERENCES ipy_profile(id) ON DELETE CASCADE,
  module_id     UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  can_view      BOOLEAN NOT NULL DEFAULT true,
  can_create    BOOLEAN NOT NULL DEFAULT true,
  can_edit      BOOLEAN NOT NULL DEFAULT true,
  can_delete    BOOLEAN NOT NULL DEFAULT false,
  can_export    BOOLEAN NOT NULL DEFAULT false,
  can_import    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (profile_id, module_id)
);

CREATE TABLE ipy_profile_field_perm (
  profile_id    UUID NOT NULL REFERENCES ipy_profile(id) ON DELETE CASCADE,
  field_id      UUID NOT NULL REFERENCES ipy_field(id) ON DELETE CASCADE,
  permission    TEXT NOT NULL DEFAULT 'editable' CHECK (permission IN ('hidden','readonly','editable')),
  PRIMARY KEY (profile_id, field_id)
);

-- Org-wide default access per module (Vtiger's def_org_share)
CREATE TABLE ipy_module_sharing (
  module_id     UUID PRIMARY KEY REFERENCES ipy_module(id) ON DELETE CASCADE,
  access        TEXT NOT NULL DEFAULT 'private'
                CHECK (access IN ('private','public_read','public_read_write','public_read_write_delete'))
);

CREATE TABLE ipy_sharing_rule (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  from_type     TEXT NOT NULL CHECK (from_type IN ('role','role_and_subordinates','group','user','all')),
  from_id       UUID,
  to_type       TEXT NOT NULL CHECK (to_type IN ('role','role_and_subordinates','group','user','all')),
  to_id         UUID,
  access        TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read','read_write')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sharing_module ON ipy_sharing_rule(module_id) WHERE is_active;

-- Explicit per-record shares ("share this deal with Priya")
CREATE TABLE ipy_record_share (
  record_id     UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('user','group','role')),
  subject_id    UUID NOT NULL,
  access        TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read','read_write')),
  shared_by     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, subject_type, subject_id)
);

-- ---------------------------------------------------------------------------
-- Custom views (list-view definitions)
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_view (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  is_public     BOOLEAN NOT NULL DEFAULT false,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  owner_id      UUID REFERENCES ipy_user(id) ON DELETE CASCADE,
  columns       JSONB NOT NULL DEFAULT '[]'::jsonb,
  filter        JSONB NOT NULL DEFAULT '{"logic":"AND","conditions":[]}'::jsonb,
  sort_by       TEXT,
  sort_dir      TEXT NOT NULL DEFAULT 'desc' CHECK (sort_dir IN ('asc','desc')),
  display_mode  TEXT NOT NULL DEFAULT 'table',
  group_by      TEXT,
  show_metrics  BOOLEAN NOT NULL DEFAULT false,
  sequence      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_view_module ON ipy_view(module_id, sequence);

-- ---------------------------------------------------------------------------
-- Layouts
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_layout (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     UUID NOT NULL REFERENCES ipy_module(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('detail','edit','quick_create','summary','convert')),
  is_default    BOOLEAN NOT NULL DEFAULT false,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sequence      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_layout_module ON ipy_layout(module_id, type);

CREATE TABLE ipy_layout_profile (
  layout_id     UUID NOT NULL REFERENCES ipy_layout(id) ON DELETE CASCADE,
  profile_id    UUID NOT NULL REFERENCES ipy_profile(id) ON DELETE CASCADE,
  PRIMARY KEY (layout_id, profile_id)
);

-- ---------------------------------------------------------------------------
-- Dashboards
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_dashboard (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  owner_id      UUID REFERENCES ipy_user(id) ON DELETE CASCADE,
  is_shared     BOOLEAN NOT NULL DEFAULT false,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  module_id     UUID REFERENCES ipy_module(id) ON DELETE CASCADE,
  -- restrict a shared dashboard to specific profiles/roles
  audience      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sequence      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_dashboard_widget (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id  UUID NOT NULL REFERENCES ipy_dashboard(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  x             INT NOT NULL DEFAULT 0,
  y             INT NOT NULL DEFAULT 0,
  w             INT NOT NULL DEFAULT 4,
  h             INT NOT NULL DEFAULT 4,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sequence      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_widget_dashboard ON ipy_dashboard_widget(dashboard_id, sequence);

-- ---------------------------------------------------------------------------
-- Audit, comments, attachments, tags, notifications
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_audit (
  id            BIGSERIAL PRIMARY KEY,
  record_id     UUID,
  module_name   TEXT NOT NULL,
  user_id       UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  changes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  source        TEXT NOT NULL DEFAULT 'app',
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_record ON ipy_audit(record_id, created_at DESC);
CREATE INDEX idx_audit_user ON ipy_audit(user_id, created_at DESC);
CREATE INDEX idx_audit_module ON ipy_audit(module_name, created_at DESC);

CREATE TABLE ipy_comment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  parent_id     UUID REFERENCES ipy_comment(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  mentions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_private    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ
);
CREATE INDEX idx_comment_record ON ipy_comment(record_id, created_at DESC);

CREATE TABLE ipy_attachment (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size            BIGINT NOT NULL DEFAULT 0,
  storage_key     TEXT NOT NULL,
  url             TEXT,
  category        TEXT,
  uploaded_by     UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  -- OCR/AI text extraction so KYC docs and agreements become searchable
  extracted_text  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachment_record ON ipy_attachment(record_id);

CREATE TABLE ipy_tag (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  color         TEXT NOT NULL DEFAULT '#64748b',
  created_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ipy_tag_link (
  tag_id        UUID NOT NULL REFERENCES ipy_tag(id) ON DELETE CASCADE,
  record_id     UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, record_id)
);
CREATE INDEX idx_tag_link_record ON ipy_tag_link(record_id);

CREATE TABLE ipy_notification (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  link          TEXT,
  record_id     UUID,
  is_read       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notification_user ON ipy_notification(user_id, is_read, created_at DESC);

CREATE TABLE ipy_starred (
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  record_id     UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, record_id)
);

CREATE TABLE ipy_recent_view (
  user_id       UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  record_id     UUID NOT NULL REFERENCES ipy_record(id) ON DELETE CASCADE,
  viewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, record_id)
);
CREATE INDEX idx_recent_user ON ipy_recent_view(user_id, viewed_at DESC);

-- ---------------------------------------------------------------------------
-- Org settings (key/value, admin editable)
-- ---------------------------------------------------------------------------

CREATE TABLE ipy_setting (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',
  label         TEXT,
  description   TEXT,
  is_secret     BOOLEAN NOT NULL DEFAULT false,
  updated_by    UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The runner bootstraps this table before applying anything, so guard it here.
CREATE TABLE IF NOT EXISTS ipy_migration (
  name          TEXT PRIMARY KEY,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
