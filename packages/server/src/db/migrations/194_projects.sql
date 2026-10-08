-- Projects — a developer's project as a record of its own.
--
-- 8 October 2026, the owner: "make me a project module in the CRM wherein we can
-- input all details of all projects we got … DLF, BPTP, Omaxe etc. projects like
-- some in Faridabad and other places." One record is one project: DLF The
-- Arbour, BPTP Terra, Omaxe World Street.
--
-- **This is the second Projects module, and the first one is why it is shaped
-- the way it is.** Migration 031 removed the original, because a unit had to
-- *point at* a project record (`project_id`) to say which project it was in —
-- so entering a unit meant creating a project first, and the project existed
-- mostly to carry its own name. 031 kept the information and dropped the
-- pointer: every inventory still carries `project_name` as plain text.
--
-- So nothing points at this module. A project stands on its own facts —
-- developer, RERA, towers, launch and possession, configurations, the price
-- band, the payment plan — and its page *finds* its units by that name, the
-- way the Builder's Floor table finds a locality's houses. Inventories and
-- Contacts are not touched by this migration or by the module.
--
-- The table holds only the columns an index needs. Every other field is added
-- by the seed (`ensureColumn`), which is where the module itself is defined —
-- a migration cannot create a module the seed does not know about (175's
-- lesson), and migrations run before the seed, so an index on a column the seed
-- has not added yet would be silently skipped (187's lesson).
CREATE TABLE IF NOT EXISTS ipy_e_projects (
  record_id      UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
  project_name   TEXT,
  developer      TEXT,
  city           TEXT,
  project_status TEXT,
  custom_fields  JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The questions a project list is asked: by name (and the units tab's lookup),
-- by developer, by city, and what stage it is at.
CREATE INDEX IF NOT EXISTS idx_projects_name      ON ipy_e_projects (lower(project_name));
CREATE INDEX IF NOT EXISTS idx_projects_developer ON ipy_e_projects (developer);
CREATE INDEX IF NOT EXISTS idx_projects_city      ON ipy_e_projects (city, project_status);

-- Any "this field was deleted" marker left by the first Projects module would
-- make the seed skip the new module's field of the same name, silently. Those
-- decisions were about a module that no longer exists.
DELETE FROM ipy_field_tombstone WHERE module_name = 'projects';
DELETE FROM ipy_block_tombstone WHERE module_name = 'projects';
