-- AI Score goes from leads, entirely.
--
-- The owner's words: "just remove it completely from the CRM, rip off
-- everything of this thing". The 0-100 score, the score drivers and the
-- scored-at timestamp all leave together — one number nobody acted on, shown
-- three ways, is three ways of noise.
--
-- What stays: the Hot / Warm / Cold rating (the band the scorer writes, which
-- SLA rules and the Hot Leads view key on), the AI Insights panel, and the
-- scorer itself — it keeps writing `rating`, just not the number.

-- 1. Tombstone the trio, so the seed does not rebuild them.
INSERT INTO ipy_field_tombstone (module_name, field_name, storage, column_name, had_values)
SELECT 'leads', x.name, 'column', x.col,
       (SELECT count(*) FROM ipy_e_leads WHERE x.col IS NOT NULL)
FROM (VALUES
  ('ai_score', 'ai_score'::text),
  ('ai_score_reasons', 'ai_score_reasons'),
  ('ai_scored_at', 'ai_scored_at')
) AS x(name, col)
ON CONFLICT (module_name, field_name) DO NOTHING;

-- 2. Take them out of every saved view.
UPDATE ipy_view
   SET columns = COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements(columns) c
                            WHERE c #>> '{}' NOT IN ('ai_score', 'ai_score_reasons', 'ai_scored_at')), '[]'::jsonb)
 WHERE columns ?| ARRAY['ai_score', 'ai_score_reasons', 'ai_scored_at'];

UPDATE ipy_view SET sort_by = NULL WHERE sort_by IN ('ai_score', 'ai_scored_at');
UPDATE ipy_view SET group_by = NULL WHERE group_by IN ('ai_score', 'ai_scored_at');

-- A filter on the score becomes a filter on its band: >= 70 was the Hot cut.
UPDATE ipy_view
   SET filter = replace(filter::text, '"field":"ai_score"', '"field":"rating"')::jsonb
 WHERE filter IS NOT NULL AND filter::text LIKE '%ai_score%';
UPDATE ipy_view
   SET filter = CASE WHEN filter::text LIKE '%greater_or_equal%'
     THEN replace(filter::text, '"operator":"greater_or_equal","value":70', '"operator":"equals","value":"Hot"')::jsonb
     ELSE filter END
 WHERE filter IS NOT NULL AND filter::text LIKE '%"rating"%';

-- 3. Layouts, dashboards and workflows.
UPDATE ipy_layout
   SET config = jsonb_set(config, '{blocks}', COALESCE((
           SELECT jsonb_agg(
                    CASE WHEN b ? 'fields'
                      THEN jsonb_set(b, '{fields}',
                             COALESCE((SELECT jsonb_agg(f) FROM jsonb_array_elements(b->'fields') f
                                        WHERE f #>> '{}' NOT IN ('ai_score', 'ai_score_reasons', 'ai_scored_at')), '[]'::jsonb))
                      ELSE b END)
             FROM jsonb_array_elements(config->'blocks') b
         ), '[]'::jsonb))
 WHERE config ? 'blocks' AND config::text LIKE '%ai_score%';

UPDATE ipy_dashboard_widget
   SET config = replace(config::text, '"ai_score"', '"rating"')::jsonb
 WHERE config::text LIKE '%ai_score%';

UPDATE ipy_workflow
   SET conditions = replace(conditions::text, '"field":"ai_score"', '"field":"rating"')::jsonb
 WHERE conditions IS NOT NULL AND conditions::text LIKE '%ai_score%';

UPDATE ipy_workflow_task
   SET config = config - 'writeTo'
 WHERE config::text LIKE '%ai_score%';

-- 4. The metadata rows themselves.
DELETE FROM ipy_field
 WHERE name IN ('ai_score', 'ai_score_reasons', 'ai_scored_at')
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'leads');

-- 5. Storage last.
ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS ai_score;
ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS ai_score_reasons;
ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS ai_scored_at;
