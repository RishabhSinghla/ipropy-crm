-- What migration 093 missed, found by a broken home screen.
--
-- 093 renamed the budget column and rewrote views, layouts and workflow
-- conditions. Four more places name a field as a string in JSON, and the
-- "Priority Leads to Call" widget on the default dashboard was one of them:
-- its filter still asked for budget_max, the query threw "Unknown field",
-- and the dashboard came back as an error boundary. Silent for nobody.
--
-- Assignment rules, WhatsApp template bodies ({{budget_max}} as a merge
-- variable) and workflow watch_fields get the same rewrite. Templates matter
-- beyond the parse: a merge variable that resolves to nothing renders an
-- empty gap in a message a customer actually receives.

UPDATE ipy_dashboard_widget
   SET config = replace(replace(config::text, '"budget_max"', '"budget"'), '"budget_min"', '"budget"')::jsonb
 WHERE config::text LIKE '%budget_max%' OR config::text LIKE '%budget_min%';

UPDATE ipy_assignment_rule
   SET conditions = replace(replace(conditions::text, '"budget_max"', '"budget"'), '"budget_min"', '"budget"')::jsonb
 WHERE conditions::text LIKE '%budget_max%' OR conditions::text LIKE '%budget_min%';

UPDATE ipy_workflow
   SET conditions = replace(replace(conditions::text, '"budget_max"', '"budget"'), '"budget_min"', '"budget"')::jsonb
 WHERE conditions IS NOT NULL AND (conditions::text LIKE '%budget_max%' OR conditions::text LIKE '%budget_min%');

UPDATE ipy_workflow
   SET watch_fields = replace(watch_fields::text, 'budget_max', 'budget')::jsonb
 WHERE watch_fields::text LIKE '%budget_max%';
UPDATE ipy_workflow
   SET watch_fields = replace(watch_fields::text, 'budget_min', 'budget')::jsonb
 WHERE watch_fields::text LIKE '%budget_min%';

UPDATE ipy_whatsapp_template
   SET body_text  = replace(replace(body_text,  '{{budget_max}}', '{{budget}}'), '{{budget_min}}', '{{budget}}'),
       buttons    = replace(replace(buttons::text, '{{budget_max}}', '{{budget}}'), '{{budget_min}}', '{{budget}}')::jsonb,
       variable_map = replace(replace(variable_map::text, 'record.budget_max', 'record.budget'), 'record.budget_min', 'record.budget')::jsonb
 WHERE body_text LIKE '%budget_max%' OR body_text LIKE '%budget_min%'
    OR buttons::text LIKE '%budget_max%' OR variable_map::text LIKE '%budget_max%';
