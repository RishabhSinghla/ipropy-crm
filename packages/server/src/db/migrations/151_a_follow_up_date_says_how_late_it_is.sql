-- A follow-up date that says "Overdue (2d)" instead of "15 Sept 2026".
--
-- The list drew every date the same way, so a rep scanning their morning
-- queue had to read each one and work out where today sits. The chip is
-- gated on `config.dueDate` rather than on the field's name: which dates
-- chase somebody is an admin's decision, and a birthday is a date too —
-- "Overdue" is the wrong word for one.
--
-- Seeded for new installs in templates/realEstate.ts. This is the half that
-- reaches a database that already has the field, including one where an
-- admin has customised it (the seed's upsert leaves those alone by design).
UPDATE ipy_field f
   SET config = coalesce(f.config, '{}'::jsonb) || '{"dueDate": true}'::jsonb
  FROM ipy_module m
 WHERE m.id = f.module_id
   AND f.name = 'next_followup_at'
   AND f.uitype IN ('date', 'datetime')
   AND NOT coalesce(f.config, '{}'::jsonb) ? 'dueDate';

-- The same idea, one line lower: which two facts identify a record under its
-- name in a list. Contact Type answers "buyer or seller" and Unit Number tells
-- two floors of one block apart — both were costing a whole column to say.
UPDATE ipy_field f
   SET config = coalesce(f.config, '{}'::jsonb) || '{"listSubtitle": true}'::jsonb
  FROM ipy_module m
 WHERE m.id = f.module_id
   AND f.name IN ('contact_type', 'unit_number', 'unit_no')
   AND NOT coalesce(f.config, '{}'::jsonb) ? 'listSubtitle';
