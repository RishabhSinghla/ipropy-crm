-- Where the companion APK is downloaded from.
--
-- Empty by default, and empty is the normal case: the CRM serves the APK that
-- was committed into its own image, so a rep taps a button in Settings and the
-- file arrives with no other service involved and nothing to pay for.
--
-- The setting exists for the day that stops being true. Move the APK to object
-- storage or a CDN, paste the address here, and every download follows it
-- without a rebuild of the app or the CRM. Same reason the phone asks the CRM
-- what to do rather than deciding: the thing most expensive to change should
-- be the thing that decides least.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'companion.apk_url',
  '""'::jsonb,
  'companion',
  'Where the Android app is downloaded from',
  'Leave empty and the CRM hands out the app itself, which is what you want. Put a web address here only if you have moved the file somewhere else, such as a storage bucket. Must start with https.'
)
ON CONFLICT (key) DO NOTHING;
