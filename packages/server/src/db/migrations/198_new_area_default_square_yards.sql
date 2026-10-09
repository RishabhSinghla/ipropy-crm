-- New records use square yards. Never reinterpret existing stored areas.
UPDATE ipy_unit_master SET is_default = (value = 'sqyd'), updated_at = now()
WHERE kind = 'area' AND EXISTS (
  SELECT 1 FROM ipy_unit_master WHERE kind = 'area' AND value = 'sqyd' AND is_active
);
