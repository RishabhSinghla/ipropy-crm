-- The watermark is gone, so the derivative that existed only to carry it is
-- gone with it.
--
-- `variants.watermarked` points at an object that will never be regenerated.
-- Left in place it is a live pointer to a stale file: `archive.ts` used to
-- prefer it for the "branded" download, so every property that was processed
-- before this change would keep serving a watermarked photo long after the
-- feature was removed, and it would look like the removal simply did not work.
--
-- The stored objects themselves are not touched. They are files in storage
-- (a container disk or R2), not rows, and SQL cannot reach them. They are
-- orphaned and harmless; anything that rebuilds a property's media will stop
-- producing them. Same for the "03 Watermarked" folders already on disk.
UPDATE ipy_attachment
   SET variants = variants - 'watermarked'
 WHERE variants ? 'watermarked';
