-- Tidy the layouts after lifecycle_stage left: a block that carried both the
-- stage and the status now holds the status twice.
--
-- 103 first rewrote the name in place, which duplicated "status" wherever a
-- block showed both — and the block that carried both was exactly the
-- confusion being retired. 103 has since changed to drop the field instead,
-- but any database that ran the first version keeps the duplicate. This
-- removes it, and no-ops where it never happened.

UPDATE ipy_layout
   SET config = jsonb_set(config, '{blocks}', (
         SELECT COALESCE(jsonb_agg(b), '[]'::jsonb)
           FROM (
             SELECT CASE WHEN jsonb_exists(b, 'fields')
               THEN jsonb_set(b, '{fields}', (
                      -- Keep the first occurrence of every field name; a
                      -- duplicate adds nothing but a React key warning.
                      SELECT COALESCE(jsonb_agg(f), '[]'::jsonb)
                        FROM (
                          SELECT f,
                                 row_number() OVER (
                                   PARTITION BY f #>> '{}'
                                   ORDER BY ord
                                 ) AS rn
                            FROM jsonb_array_elements(b->'fields') WITH ORDINALITY AS t(f, ord)
                        ) x
                       WHERE rn = 1
                      ))
               ELSE b END AS b
               FROM jsonb_array_elements(config->'blocks') b
           ) fixed
       ))
 WHERE config ? 'blocks'
   AND EXISTS (
     SELECT 1
       FROM jsonb_array_elements(config->'blocks') b
      WHERE jsonb_exists(b, 'fields')
        AND (SELECT count(*) FROM (
               SELECT f FROM jsonb_array_elements(b->'fields') f GROUP BY f HAVING count(*) > 1
             ) d) > 0
   );
