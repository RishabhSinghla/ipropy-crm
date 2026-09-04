-- The birthday greeting has not run since 11 August.
--
-- Its condition asks for `do_not_whatsapp`, one of the three consent booleans
-- deleted that day. A condition naming a field that does not exist makes
-- `buildWhere` raise a 400, the scheduler catches it and writes "scheduled
-- workflow failed" to a log nobody reads, and the workflow is simply skipped.
-- The other scheduled workflows keep running, so nothing looked wrong.
--
-- The condition is dropped rather than repointed at the new consent store,
-- because the send path already checks it: every WhatsApp send goes through
-- `maySend`, which reads `ipy_channel_optout`. Anyone who replied STOP is
-- blocked there. Checking twice in two different ways is what produced this
-- bug in the first place.
--
-- Written defensively so it no-ops on a database that never had the condition.

UPDATE ipy_workflow
   SET conditions = jsonb_set(
         conditions,
         '{conditions}',
         (
           SELECT COALESCE(jsonb_agg(c), '[]'::jsonb)
             FROM jsonb_array_elements(conditions->'conditions') AS c
            WHERE c->>'field' NOT IN ('do_not_whatsapp', 'do_not_call', 'email_opt_out')
         )
       ),
       updated_at = now()
 WHERE conditions ? 'conditions'
   AND jsonb_typeof(conditions->'conditions') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(conditions->'conditions') AS c
      WHERE c->>'field' IN ('do_not_whatsapp', 'do_not_call', 'email_opt_out')
   );
