-- Keep immutable unit values intact; only the displayed master label changes.
UPDATE ipy_unit_master SET label = 'Total'
WHERE kind = 'budget_demand' AND
  (value = 'total' OR lower(regexp_replace(label, '\s+', '', 'g')) = 'lumpsum');
