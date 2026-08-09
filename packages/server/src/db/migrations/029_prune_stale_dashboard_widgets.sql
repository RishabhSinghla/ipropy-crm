-- ===========================================================================
-- iPropy CRM — 029: dashboards that outlived their modules
--
-- Retiring Bookings and Payments in 025 left eleven widgets querying tables
-- nothing can reach any more — a quarter of every dashboard in the product,
-- and the whole of "Collections & Finance". They do not error loudly; a widget
-- whose module has gone renders as an empty card or a zero, which is worse,
-- because a zero on a revenue tile reads as a fact.
--
-- Caught in review rather than by a test: nothing type-checks a `module` name
-- stored inside a JSONB config, which is the trade the metadata-driven design
-- makes everywhere. Worth remembering the next time a module is retired.
-- ===========================================================================

-- Widgets pointing at a module that is no longer active.
DELETE FROM ipy_dashboard_widget w
WHERE w.config->>'module' IN (SELECT name FROM ipy_module WHERE is_active = false);

-- Dashboards left with nothing on them. Only the ones that are now empty —
-- a dashboard that lost one widget of eight is still a dashboard.
DELETE FROM ipy_dashboard d
WHERE NOT EXISTS (SELECT 1 FROM ipy_dashboard_widget w WHERE w.dashboard_id = d.id)
  AND d.is_system = true;

-- Widget column lists still naming the retired name halves. `full_name` is the
-- field now; a widget naming `first_name` renders a blank column.
--
-- Rebuilt WITH ORDINALITY rather than with `jsonb_agg(DISTINCT …)`: DISTINCT
-- discards the original ordering, and column order is the one thing a column
-- list is for. Duplicates are dropped by keeping the first occurrence, so a
-- widget listing both halves collapses to a single `full_name` in its place.
UPDATE ipy_dashboard_widget w
SET config = jsonb_set(w.config, '{columns}', rebuilt.columns)
FROM (
  SELECT
    id,
    jsonb_agg(name ORDER BY position) AS columns
  FROM (
    SELECT DISTINCT ON (id, name)
      w2.id,
      CASE WHEN col.value #>> '{}' IN ('first_name', 'last_name')
           THEN '"full_name"'::jsonb
           ELSE col.value
      END AS name,
      col.position
    FROM ipy_dashboard_widget w2,
         jsonb_array_elements(w2.config->'columns') WITH ORDINALITY AS col(value, position)
    WHERE w2.config ? 'columns'
      AND (w2.config->'columns')::text LIKE '%name%'
    ORDER BY w2.id, name, col.position
  ) AS deduped
  GROUP BY id
) AS rebuilt
WHERE w.id = rebuilt.id;
