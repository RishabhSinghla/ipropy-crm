-- ===========================================================================
-- iPropy CRM — 052: which photo goes first
--
-- Photos came back in the order they were shot: `ai_category`, then
-- `captured_at`, then upload time. That is a sensible default and a bad
-- answer to the only question anyone asks about a property's photos, which is
-- "which one does the buyer see first". The first frame of a site visit is
-- usually the gate, or a hand in front of the lens.
--
-- `sort_order` is NULL until somebody arranges the set, and NULLs sort last,
-- so nothing changes for a property nobody has curated — the capture order
-- still holds. Arranging one writes an explicit position for every photo in
-- it, which is what makes "make this the cover" a single, obvious operation
-- rather than a special `is_cover` flag that then has to be kept unique.
-- ===========================================================================

ALTER TABLE ipy_attachment ADD COLUMN IF NOT EXISTS sort_order INTEGER;

COMMENT ON COLUMN ipy_attachment.sort_order IS
  'Manual position within a record''s attachments. NULL means "never arranged" and falls back to capture order. Lower is earlier; the cover photo is the lowest.';

-- Reads are always scoped to one record, and the ordering is the hot path for
-- the carousel, the share link and the public catalogue.
CREATE INDEX IF NOT EXISTS idx_attachment_record_order
  ON ipy_attachment(record_id, sort_order NULLS LAST);
