-- One number where there were two.
--
-- budget_min / budget_max asked "a range" for a business that almost always
-- states one price. The owner folded them into a single field, `budget`,
-- labelled "Budget / Demand": what the buyer wants, full stop.
--
-- Data: a lead whose max was empty takes its min, so nothing is lost. The
-- column itself is renamed rather than rebuilt — history stays attached.
-- budget_min is dropped and tombstoned like any field the owner removed.
--
-- References: saved views (columns and filters), layouts and workflow
-- conditions name fields as strings in JSON. Both old names are rewritten to
-- the new one in place; a view that filtered the range now filters the one
-- number twice, which is the same range when min equalled max, and narrower
-- than the old outer envelope where it did not — the honest reading of "one
-- budget".

UPDATE ipy_e_leads SET budget_max = budget_min
 WHERE budget_max IS NULL AND budget_min IS NOT NULL;

ALTER TABLE ipy_e_leads RENAME COLUMN budget_max TO budget;
ALTER TABLE ipy_e_leads DROP COLUMN budget_min;

DELETE FROM ipy_field
 WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'leads')
   AND name IN ('budget_min', 'budget_max');

INSERT INTO ipy_field_tombstone (module_name, field_name, storage)
SELECT 'leads', x, 'column'
FROM (VALUES ('budget_min'), ('budget_max')) AS v(x)
ON CONFLICT DO NOTHING;

UPDATE ipy_view SET columns = replace(columns::text, '"budget_max"', '"budget"')::jsonb
 WHERE columns::text LIKE '%budget_max%';
UPDATE ipy_view SET columns = replace(columns::text, '"budget_min"', '"budget"')::jsonb
 WHERE columns::text LIKE '%budget_min%';
UPDATE ipy_view SET filter = replace(filter::text, '"budget_max"', '"budget"')::jsonb
 WHERE filter IS NOT NULL AND filter::text LIKE '%budget_max%';
UPDATE ipy_view SET filter = replace(filter::text, '"budget_min"', '"budget"')::jsonb
 WHERE filter IS NOT NULL AND filter::text LIKE '%budget_min%';

UPDATE ipy_layout SET config = replace(config::text, '"budget_max"', '"budget"')::jsonb
 WHERE config::text LIKE '%budget_max%';
UPDATE ipy_layout SET config = replace(config::text, '"budget_min"', '"budget"')::jsonb
 WHERE config::text LIKE '%budget_min%';

UPDATE ipy_workflow SET conditions = replace(conditions::text, '"budget_max"', '"budget"')::jsonb
 WHERE conditions IS NOT NULL AND conditions::text LIKE '%budget_max%';
UPDATE ipy_workflow SET conditions = replace(conditions::text, '"budget_min"', '"budget"')::jsonb
 WHERE conditions IS NOT NULL AND conditions::text LIKE '%budget_min%';
