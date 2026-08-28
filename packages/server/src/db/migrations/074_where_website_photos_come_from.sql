-- Whether the website shows your logo on the photographs — and, underneath it,
-- the fix for a pipeline that had been failing on its last step for six days.
--
-- n8n held the website folder as the literal string `07_WEBSITE`, left over
-- from an earlier workflow. Nothing has created a folder by that name since
-- 22 August, so the last three steps of every media run — read the finished
-- pictures, send them to the CRM, mark the property done — did not run. The
-- pictures were made correctly every time and then stayed in OneDrive, and
-- because the property was never marked done it was picked up and reprocessed
-- every two minutes, for ever.
--
-- The real error, from the run on 23 August:
--   No file matching the selector "/data/properties/B12-4bhk/07_WEBSITE/*" found
--
-- The CRM names a property's folders, so the CRM is the only thing that can say
-- which one to publish from without the two drifting apart again. n8n is told
-- the path with the job now and holds no folder names of its own.
--
-- A switch rather than a box to type a path into. Both sets of pictures are
-- made on every run, so this only decides which is published — nothing is
-- reprocessed when it changes, and there is no way to point the worker at a
-- folder it should not read. See `propertyWebsitePath` in core/storage/keys.ts.

INSERT INTO ipy_setting (key, value, category, label, description) VALUES
  ('media.watermark_website_photos', 'false'::jsonb, 'website',
   'Put your logo on website photographs',
   'On, and the photographs on your public website carry your logo, which makes '
   || 'them harder for other brokers to lift and use as their own. Off, and they '
   || 'are shown clean, which looks better. Both versions are made for every '
   || 'property either way, so you can change your mind whenever you like and '
   || 'the next property you finish follows the new setting. Nothing is '
   || 'reprocessed and nothing is lost.')
ON CONFLICT (key) DO NOTHING;
