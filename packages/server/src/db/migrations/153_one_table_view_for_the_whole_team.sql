-- One column order for every table, set once and shared by everybody.
--
-- Each person could arrange their own columns and every saved list carried a
-- set of its own, so "the third column" meant three different things to three
-- people and the same list looked different to each of them. `ui.list_columns`
-- is the single answer now; Admin → Table View is where it is changed.
--
-- The order below is the owner's, given in labels. Turned into field names by
-- reading the modules rather than by guessing, because the labels and the names
-- disagree in two places that matter: leads' "Bedrooms" is the field
-- `configuration`, and Inventory's Portion is `portion_type` while leads' is
-- `portion`. A column naming a field that does not exist is skipped silently,
-- which would have read as "the setting did not work".
--
-- Contact Type and Unit Number are deliberately absent: they read under the
-- name now (migration 151), and the owner asked for them out of the table —
-- contact type is reachable from the filters and a unit number from search.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'ui.list_columns',
  jsonb_build_object(
    'leads', jsonb_build_array(
      'full_name', 'mobile', 'configuration', 'area_size', 'budget',
      'next_followup_at', 'lead_status', 'assigned_to', 'floor', 'category',
      'portion', 'preferred_locations'
    ),
    'properties', jsonb_build_array(
      'full_name', 'mobile', 'bedrooms', 'area_size', 'asking_price',
      'next_follow_up', 'status', 'assigned_to', 'floor', 'category',
      'portion_type', 'preferred_locations'
    )
  ),
  'ui',
  'Table columns',
  'The columns every table shows, per module, in order. Admin → Table View.'
)
ON CONFLICT (key) DO NOTHING;
