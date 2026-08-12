-- Admin-controlled, privacy-first property share links.
-- Exact unit identity and location remain off until an administrator chooses
-- to reveal them. The server applies this list before building its SELECT, so
-- hidden values never enter an unauthenticated response.
INSERT INTO ipy_setting (key, value, category, label, description)
VALUES (
  'sharing.property_link',
  '{
    "visibleFields": [
      "property_type", "configuration",
      "floor", "facing", "view_description", "corner_unit", "vastu_compliant",
      "bedrooms", "bathrooms", "balconies", "parking_slots", "furnishing",
      "carpet_area", "built_up_area", "super_built_up_area", "plot_area",
      "balcony_area", "terrace_area", "area_unit",
      "total_price", "monthly_rent", "maintenance_monthly",
      "possession_status", "possession_date", "is_resale", "age_of_property",
      "amenities", "description"
    ],
    "showPhotos": true
  }'::jsonb,
  'sharing',
  'Property share links',
  'Controls exactly which property details and photos a buyer can see through a private share link.'
)
ON CONFLICT (key) DO NOTHING;
