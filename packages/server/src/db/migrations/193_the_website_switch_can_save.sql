-- The "Show on website" switch on an inventory, made able to save.
--
-- Read off production on 8 October 2026: `publish_to_web` on Inventories was
-- `is_active = false`. `prepareValues` skips a switched-off field, so every
-- press of the switch answered 200, toasted "Shown on the website", stored
-- nothing, and snapped back. 0 of 25,132 inventories had ever been ticked, and
-- no audit row anywhere records a "true".
--
-- Switched back on and left `hidden`: the field stays off every form, which is
-- the reason it was hidden in the first place. The switch in the record's More
-- menu and right-hand pane is the one way to set it.
--
-- Guarded on the module so it no-ops on a fresh database, where the seed
-- creates the field active anyway.
UPDATE ipy_field f
   SET is_active = true, updated_at = now()
  FROM ipy_module m
 WHERE m.id = f.module_id
   AND m.name = 'properties'
   AND f.name = 'publish_to_web'
   AND f.is_active = false;
