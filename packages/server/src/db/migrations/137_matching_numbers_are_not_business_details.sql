-- The three matching numbers had wandered into "Your business".
--
-- `ipy_setting.category` defaults to 'general', and the Matching Setup screen
-- writes its three rows without naming one — so `matching.price_grace_percent`,
-- `matching.area_grace_percent` and `matching.field_map` were filed alongside
-- the company's name, address and opening hours.
--
-- The Settings page renders whatever is in this table, grouped by category,
-- with the label and description the row carries. These three carry neither.
-- So what an administrator opening Settings actually saw was the raw keys,
-- in among their registered address, and one of them printing a wall of JSON
-- under the words "Needs its own editor" — which it has. Matching Setup is
-- that editor, and it is a whole screen with a field mapper on it.
--
-- Two halves, and both are needed:
--
--  * `category = 'matching'` puts them where they belong, which is also what
--    takes them off the Settings page: that page skips categories owned by a
--    screen of their own, exactly as it already does for brand and social.
--  * A label and a description, because a row with a category and no label
--    still renders as its key anywhere else that lists settings, and a key is
--    not something a sales head can make a decision about.
--
-- The INSERTs in `api/routes/admin.ts` name the category now too, so re-saving
-- Matching Setup cannot put them back where they were.

UPDATE ipy_setting
SET category = 'matching',
    label = CASE key
      WHEN 'matching.price_grace_percent' THEN 'Budget headroom'
      WHEN 'matching.area_grace_percent'  THEN 'Size headroom'
      WHEN 'matching.field_map'           THEN 'Which field answers which'
      ELSE label
    END,
    description = CASE key
      WHEN 'matching.price_grace_percent' THEN
        'How far above a buyer''s stated budget a unit may still be offered, as a percentage. '
        || 'At 10, somebody who said one crore is shown units up to ₹1.10 Cr.'
      WHEN 'matching.area_grace_percent' THEN
        'How far under the size somebody asked for a unit may still be offered, as a percentage.'
      WHEN 'matching.field_map' THEN
        'The pairs of fields matching compares — a buyer''s Bedrooms against a unit''s Bedrooms, '
        || 'and so on. Edited on Admin → Matching Setup.'
      ELSE description
    END
WHERE key IN (
  'matching.price_grace_percent',
  'matching.area_grace_percent',
  'matching.field_map'
);
