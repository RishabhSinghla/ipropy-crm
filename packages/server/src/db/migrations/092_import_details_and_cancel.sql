-- Imports you can watch, and stop.
--
-- Two gaps in the import screen, hit on the first real import:
--
-- A running job reported its counts as static numbers. The loop updated them
-- every 25 rows, and nothing stored WHICH rows succeeded, skipped or failed -
-- so "23 skipped" was a number to wonder about, not a list to read.
--
-- And there was no way to stop one. A mis-mapped 10,000-row sheet ran to
-- completion while the person who started it watched.
--
-- `details` holds the created and skipped rows (bounded; a 50,000-row import
-- does not need 50,000 strings in one jsonb cell). `status` gains the
-- cancelling/cancelled pair: the endpoint flips running to cancelling, the
-- worker notices on its next progress write and stops.

ALTER TABLE ipy_import_job
  ADD COLUMN details jsonb NOT NULL DEFAULT '{"created":[],"skipped":[]}'::jsonb;
