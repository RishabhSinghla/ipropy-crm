-- Builder Floors opened on "On the Market", which hides Sold and Not for Sale records, so the
-- module looked half empty on first open. The owner wants every status shown by default
-- (25 November 2026). "On the Market" stays as a list; nothing is deleted.
UPDATE ipy_view v
   SET is_default = (v.name = 'All Builder Floors')
  FROM ipy_module m
 WHERE m.id = v.module_id
   AND m.name = 'builder_floors'
   AND v.is_system = true
   AND v.overrides_view_id IS NULL
   AND v.name IN ('On the Market', 'All Builder Floors');
