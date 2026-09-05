-- An import that meets a row already in the CRM had exactly two answers:
-- throw the row away, or create a second copy of the person. Neither is what
-- anybody wants. What they want is to look at the two side by side and say
-- which value is right — the sheet has this month's budget, the CRM has the
-- owner and the call history — and that decision cannot be made by a rule
-- written before the file was opened.
--
-- So the importer now records every row's outcome instead of only counting it,
-- and a duplicate is parked rather than resolved. Two things fall out of the
-- same table:
--
--   * the review screen, which reads the parked rows and writes back what the
--     person chose; and
--   * the downloadable result, which needs every row and not the first 300
--     that `ipy_import_job.details` can hold.
--
-- `values` is the mapped row as the importer built it, not the raw CSV line:
-- it is what a merge would actually write, so it is what the reviewer has to
-- be shown.

CREATE TABLE IF NOT EXISTS ipy_import_row (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES ipy_import_job(id) ON DELETE CASCADE,
  -- 1-based line in the sheet as the user sees it in Excel (header is line 1).
  row_number    INT  NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('created','skipped','failed','duplicate')),
  -- The mapped values for this row.
  values        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The record this row became, once it became one.
  record_id     UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  label         TEXT,
  -- Why it was skipped or how it failed. Null on a clean create.
  message       TEXT,
  -- For a duplicate: the record already in the CRM. Which fields matched is
  -- deliberately *not* stored — it is derived from the live record when the
  -- comparison is drawn, so a mobile edited between the import and the review
  -- does not leave the screen claiming a match that no longer exists.
  existing_id   UUID REFERENCES ipy_record(id) ON DELETE CASCADE,
  -- Null while the duplicate is still waiting for a person.
  resolution    TEXT CHECK (resolution IN ('merged','skipped','created')),
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The review screen's query: this job's duplicates that nobody has answered
-- yet, oldest first. Partial, because the pending set is a handful of rows out
-- of a file that may hold ten thousand.
CREATE INDEX IF NOT EXISTS idx_import_row_pending
  ON ipy_import_row (job_id, row_number)
  WHERE outcome = 'duplicate' AND resolution IS NULL;

-- The CSV download's query, and the per-section counts above it.
CREATE INDEX IF NOT EXISTS idx_import_row_job
  ON ipy_import_row (job_id, outcome, row_number);

-- "Ask me at the end" joins skip / create as a way to handle a collision.
ALTER TABLE ipy_import_job DROP CONSTRAINT IF EXISTS ipy_import_job_duplicate_handling_check;
ALTER TABLE ipy_import_job
  ADD CONSTRAINT ipy_import_job_duplicate_handling_check
  CHECK (duplicate_handling IN ('skip','overwrite','merge','create','review'));

-- How many of this job's duplicates are still waiting. Denormalised because
-- the jobs list renders it for twenty jobs at once and a per-row COUNT there
-- is twenty extra queries for a badge.
ALTER TABLE ipy_import_job
  ADD COLUMN IF NOT EXISTS duplicate_rows INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_rows   INT NOT NULL DEFAULT 0;
