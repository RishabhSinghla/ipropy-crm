-- The Matching tab, appended to layouts the seed cannot reach.
--
-- Contacts ↔ Properties matching ships as a record-detail tab, right after
-- Timeline. The seed writes it into every default layout it rebuilds — but a
-- layout an admin has edited is marked is_customised and the seed deliberately
-- never touches it, so installs whose admins had rearranged their tabs would
-- never see the feature at all. Production is exactly that install: its leads
-- layout is customised.
--
-- The splice keeps the admin's own order: everything up to and including
-- Timeline, then the new tab, then the rest. An admin can still move or remove
-- it in the Layout Designer afterwards — this only guarantees the feature is
-- discoverable on day one rather than invisible.

UPDATE ipy_layout l
   SET config = jsonb_set(config, '{tabs}',
         (SELECT COALESCE(jsonb_agg(v ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements(l.config->'tabs') WITH ORDINALITY AS t(v, ord)
           WHERE v->>'key' IN ('overview', 'timeline'))
       || jsonb_build_object('key', 'matching', 'icon', 'link-2')
       || (SELECT COALESCE(jsonb_agg(v ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements(l.config->'tabs') WITH ORDINALITY AS t(v, ord)
           WHERE v->>'key' NOT IN ('overview', 'timeline', 'matching'))
       ),
       updated_at = now()
 WHERE l.type = 'detail'
   AND l.is_default = true
   AND l.module_id IN (SELECT id FROM ipy_module WHERE name IN ('leads', 'properties'))
   AND NOT (l.config->'tabs' @> '[{"key": "matching"}]'::jsonb);

-- The owner named both labels: on a contact, the properties that fit; on a
-- property, the contacts that fit. The module decides which.
UPDATE ipy_layout l
   SET config = jsonb_set(config, '{tabs}', (
         SELECT jsonb_agg(
                  CASE WHEN v->>'key' = 'matching'
                    THEN jsonb_set(v, '{label}', to_jsonb(
                           CASE m.name WHEN 'leads' THEN 'Matching property'
                                        ELSE 'Matching contacts' END))
                    ELSE v END)
           FROM jsonb_array_elements(l.config->'tabs') AS t(v),
                ipy_module m
           WHERE m.id = l.module_id
       ))
 WHERE l.type = 'detail'
   AND l.is_default = true
   AND l.module_id IN (SELECT id FROM ipy_module WHERE name IN ('leads', 'properties'));
