-- ===========================================================================
-- iPropy CRM — 021: saved designs and the render queue
--
-- The studio shipped able to draw a post and download it, and able to remember
-- none of it. That is the difference between a toy and a tool: a price change
-- means redoing the post from scratch rather than opening it and editing one
-- number.
--
-- A design is stored as its layer JSON, not as a PNG, for the same reason the
-- renderer is shared between preview and export — the editable thing and the
-- published thing must never drift apart.
--
-- Renders (reels, brochures) are queued rather than done inline. ffmpeg on a
-- dozen photos takes tens of seconds, which is far past what an HTTP request
-- should hold open, and the scheduler already drains queues on a tick.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_design (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  -- 'post' is canvas layers; 'reel' and 'brochure' are render specs.
  kind         TEXT NOT NULL DEFAULT 'post'
               CHECK (kind IN ('post','reel','brochure')),
  template_key TEXT,
  -- Which listing this was generated from, so "regenerate from current data"
  -- is possible after a price change.
  record_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  module_name  TEXT,
  width        INT NOT NULL DEFAULT 1080,
  height       INT NOT NULL DEFAULT 1080,
  -- The Design object from web/src/lib/design.ts, verbatim.
  spec         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- A small PNG data URL so the gallery does not have to re-render every card.
  thumbnail    TEXT,
  created_by   UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_design_kind ON ipy_design(kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_record ON ipy_design(record_id);

CREATE TABLE IF NOT EXISTS ipy_render_job (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL CHECK (kind IN ('reel','brochure','image_edit')),
  design_id    UUID REFERENCES ipy_design(id) ON DELETE SET NULL,
  record_id    UUID REFERENCES ipy_record(id) ON DELETE SET NULL,
  -- Everything the renderer needs: photo ids, captions, music, ken-burns flags.
  spec         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','completed','failed','unsupported')),
  progress     SMALLINT NOT NULL DEFAULT 0,
  -- Storage key of the finished artefact, resolved through the storage driver.
  output_key   TEXT,
  output_mime  TEXT,
  attachment_id UUID,
  error        TEXT,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  requested_by UUID REFERENCES ipy_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_render_queue ON ipy_render_job(status, created_at)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_render_requester ON ipy_render_job(requested_by, created_at DESC);
