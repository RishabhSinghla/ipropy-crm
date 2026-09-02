-- Rating and Lifecycle Stage stop accepting edits that were never kept.
--
-- Both are derived. `rating` is the Hot/Warm/Cold band of `ai_score`, and
-- `ai_score` has been read-only since it was built. `lifecycle_stage` is driven
-- by the pipeline status through `lifecycleFromStatus.ts`, forward only.
--
-- Neither was marked read-only, and the consequences were different but both
-- silent:
--
--  * A rep set Rating to Hot. The API answered 200, the audit trail recorded
--    "Warm to Hot" as a change that succeeded, and the scorer overwrote it
--    moments later. The database kept Warm. It only bit when the same save also
--    touched a scoring input, so it looked random.
--  * A rep could PATCH a Customer straight back to Lead — the exact outcome the
--    forward-only rule exists to prevent. The rule guards the status path; the
--    field was writable around it.
--
-- Migration 076 already set this flag on `lifecycle_stage`. **The seed put it
-- straight back**, because field structure is the one thing the seed re-upserts
-- and `docker-entrypoint.sh` re-seeds on every cold start. So the guard was
-- being undone several times a day. It is declared in the seed template now,
-- which is what makes it durable; this migration is only so existing databases
-- stop accepting the edit before their next restart.

UPDATE ipy_field
   SET is_readonly = true,
       display_type = 'readonly'
 WHERE name IN ('rating', 'lifecycle_stage')
   AND module_id IN (SELECT id FROM ipy_module WHERE name = 'leads')
   AND is_readonly = false;
