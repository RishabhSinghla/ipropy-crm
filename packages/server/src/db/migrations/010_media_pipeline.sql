-- Media processing pipeline: derivative image/video variants (thumbnail,
-- medium, large — plus a processed video) generated async from an uploaded
-- original, which is never modified. `variants` NULL means "not processed
-- yet, or processing wasn't applicable" — every consumer falls back to the
-- original attachment in that case, so this is purely additive.
ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS variants JSONB NULL;

-- Same FOR UPDATE SKIP LOCKED claim pattern as ipy_task_queue
-- (core/workflow/scheduler.ts), but not FK'd to workflow/task — this queue
-- is attachment-triggered, not workflow-triggered, so it gets its own table
-- rather than being shoehorned into the workflow one.
CREATE TABLE IF NOT EXISTS ipy_media_job (
  id                BIGSERIAL PRIMARY KEY,
  attachment_id     UUID NOT NULL REFERENCES ipy_attachment(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','done','failed')),
  attempts          INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 3,
  last_error        TEXT,
  locked_at         TIMESTAMPTZ,
  locked_by         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_media_job_pending ON ipy_media_job(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_media_job_attachment ON ipy_media_job(attachment_id);
