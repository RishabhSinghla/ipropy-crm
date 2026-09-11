-- ===========================================================================
-- iPropy CRM — 132: the share default was frozen into data and went stale
--
-- Migration 042 wrote the buyer-facing field list into `ipy_setting` as
-- twenty-six field names. Production has since permanently deleted twenty-one
-- of them, so a share link showed five details — floor, facing, bedrooms,
-- bathrooms, possession status — and no price and no size at all. The fields
-- an admin created to replace them, `asking_price` and `area_size`, were never
-- considered, because nothing adds a new field to a list written in 2026.
--
-- A default that has to follow the field set does not belong in a row. It
-- belongs in code, stated as what to withhold rather than what to show, so
-- that a field created tomorrow is covered without anybody remembering to
-- cover it — `defaultShareFields` in `core/sharing/propertyShare.ts`.
--
-- So this deletes the row, and `getPropertyShareConfig` falls through to that
-- default. Only when `updated_by IS NULL`: that is the honest signal nobody
-- has ever opened the screen and saved, since `savePropertyShareConfig`
-- always stamps the user. An admin's choices are theirs and are left exactly
-- as they are — including a deliberate choice that happens to match the old
-- list.
--
-- Nothing is lost by the delete. The row is recreated in full the first time
-- somebody saves on Admin → Sharing, and the privacy promise is unchanged:
-- identity, exact location and the state of the sale stay off until chosen.
-- ===========================================================================

DELETE FROM ipy_setting
 WHERE key = 'sharing.property_link'
   AND updated_by IS NULL;
