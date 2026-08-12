-- ===========================================================================
-- iPropy CRM — 045: the studio is gone
--
-- A design editor inside the CRM was the wrong thing to own. It is a large,
-- open-ended surface that competes for attention with the pipeline that
-- actually saves the day's work, and creatives are made in a dedicated tool
-- instead. Removed with it: canvas designs, saved templates, AI photo editing,
-- reel rendering and PDF brochures.
--
-- What deliberately survives, because it is the media pipeline rather than the
-- studio: watermarking, image derivatives and video derivatives. Those run
-- automatically on every upload with no UI at all, and publishing depends on
-- them.
--
-- Dropping rather than leaving the tables orphaned: `ipy_design` held nothing
-- and `ipy_render_job` held three test rows, so there is no history worth
-- keeping and a dead table is a trap for the next person reading the schema.
-- Finished renders were written to `ipy_attachment` and are untouched — the
-- files anyone actually produced remain downloadable from their property.
-- ===========================================================================

DROP TABLE IF EXISTS ipy_render_job;
DROP TABLE IF EXISTS ipy_design;
