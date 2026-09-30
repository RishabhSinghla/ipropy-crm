-- Admin → Quick Filters: how the Quick & Live Filters panel is arranged, per
-- module — which sections, in what order, called what, folded or open.
--
-- Seeded empty on purpose: `{}` means the shipped arrangement, which is built
-- from each module's own fields, so this migration changes nothing anybody
-- sees. The row exists up front because `PUT /api/admin/settings` files a key
-- it has never seen under `general`, and the screen asks for `ui` — the
-- symptom being a settings page that saves and reads back empty.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'ui.quick_filters',
  '{}'::jsonb,
  'ui',
  'Quick filters',
  'The Quick & Live Filters panel, per module: its sections, their order and names. Admin → Quick Filters.'
)
ON CONFLICT (key) DO NOTHING;
