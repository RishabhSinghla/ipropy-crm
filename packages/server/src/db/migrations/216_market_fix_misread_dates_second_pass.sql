-- 20 October 2026, second pass over what migration 215 left.
--
-- 215 found the misread sightings by the transaction that wrote them (xmin), starting from the earliest
-- *current* xmin among the new deals. A deal that was written and then updated again has a newer xmin, so
-- the first sightings (written before that) were below its line and were missed: on production about 7,400
-- of them, with 4,956 still dated in the future and 675 notes on Associates still dated 2027–2028.
--
-- The line is drawn from the sightings themselves now, which are never updated: the earliest one a new deal
-- has. Everything 215 already turned back was rewritten in its own transaction, so it sits *above* 215's
-- own transaction id and is not touched again. Same inversion, same safety checks, same no-op on a database
-- that never had those imports.
DO $repair$
DECLARE
  window_start CONSTANT timestamptz := '2026-10-20 11:00+00';
  window_end   CONSTANT timestamptz := '2026-10-20 13:30+00';
  touched_groups text[];
  first_pass bigint;
  threshold bigint;
BEGIN
  SELECT array_agg(DISTINCT group_name) INTO touched_groups
    FROM ipy_market_import
   WHERE created_at BETWEEN window_start AND window_end AND status <> 'duplicate';
  SELECT xmin::text::bigint INTO first_pass FROM ipy_migration WHERE name = '215_market_fix_misread_dates.sql';
  IF touched_groups IS NULL OR first_pass IS NULL THEN
    RETURN;
  END IF;
  SELECT min(s.xmin::text::bigint) INTO threshold
    FROM ipy_market_post_seen s JOIN ipy_market_post p ON p.id = s.post_id
   WHERE p.created_at BETWEEN window_start AND window_end AND s.xmin::text::bigint < first_pass;
  IF threshold IS NULL THEN
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION pg_temp.market_true_date(posted timestamptz) RETURNS timestamptz LANGUAGE plpgsql AS $fn$
  DECLARE
    local_time timestamp := posted AT TIME ZONE 'Asia/Kolkata';
    real_month int := extract(day FROM local_time)::int;
    real_day   int := (extract(year FROM local_time)::int - 2026) * 12 + extract(month FROM local_time)::int;
    answer timestamptz;
  BEGIN
    answer := make_timestamptz(2026, real_month, real_day,
                               extract(hour FROM local_time)::int, extract(minute FROM local_time)::int, 0, 'Asia/Kolkata');
    IF answer < timestamptz '2026-08-01 00:00+00' OR answer > now() + interval '1 day' THEN RETURN NULL; END IF;
    RETURN answer;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END
  $fn$;

  CREATE TEMP TABLE market_bad_seen (
    row_id tid, post_id uuid, group_name text, sender text, posted_at timestamptz, true_at timestamptz
  ) ON COMMIT DROP;
  INSERT INTO market_bad_seen
  SELECT s.ctid, s.post_id, s.group_name, s.sender, s.posted_at, pg_temp.market_true_date(s.posted_at)
    FROM ipy_market_post_seen s
   WHERE s.group_name = ANY (touched_groups) AND s.posted_at IS NOT NULL
     AND s.xmin::text::bigint >= threshold AND s.xmin::text::bigint < first_pass;

  DELETE FROM ipy_market_post_seen s USING market_bad_seen b
   WHERE s.ctid = b.row_id AND b.true_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM ipy_market_post_seen o
                  WHERE o.post_id = b.post_id AND o.group_name = b.group_name AND o.sender = b.sender AND o.posted_at = b.true_at);
  DELETE FROM ipy_market_post_seen s USING market_bad_seen b
   WHERE s.ctid = b.row_id AND b.true_at IS NULL AND b.posted_at > now() + interval '1 day';

  BEGIN
    UPDATE ipy_market_post_seen s SET posted_at = b.true_at
      FROM market_bad_seen b WHERE s.ctid = b.row_id AND b.true_at IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM ipy_market_post_seen s USING market_bad_seen b WHERE s.ctid = b.row_id AND b.true_at IS NOT NULL;
  END;

  CREATE TEMP TABLE market_fixed_posts (post_id uuid) ON COMMIT DROP;
  INSERT INTO market_fixed_posts SELECT DISTINCT post_id FROM market_bad_seen;
  UPDATE ipy_market_post p
     SET last_posted_at = x.last_at, first_posted_at = x.first_at
    FROM (SELECT s.post_id, max(s.posted_at) AS last_at, min(s.posted_at) AS first_at
            FROM ipy_market_post_seen s
           WHERE s.post_id IN (SELECT post_id FROM market_fixed_posts)
             AND s.posted_at IS NOT NULL AND s.posted_at <= now() + interval '1 day'
           GROUP BY s.post_id) x
   WHERE p.id = x.post_id;
  UPDATE ipy_market_post SET last_posted_at = least(created_at, now()) WHERE last_posted_at > now() + interval '1 day';
  UPDATE ipy_market_post SET first_posted_at = least(created_at, now()) WHERE first_posted_at > now() + interval '1 day';

  -- Notes: every one of a repaired deal, and any note still dated in the future, takes its deal's first date.
  UPDATE ipy_comment c
     SET created_at = p.first_posted_at,
         body = regexp_replace(c.body, E'^(💬 WhatsApp · [^\\n]*) · [^\\n·]*\\n',
                               E'\\1 · ' || to_char(p.first_posted_at AT TIME ZONE 'Asia/Kolkata', 'FMDD Mon YYYY') || E'\n')
    FROM ipy_market_post p
   WHERE c.market_post_id = p.id AND p.first_posted_at IS NOT NULL
     AND (p.id IN (SELECT post_id FROM market_fixed_posts) OR c.created_at > now() + interval '1 day');

  UPDATE ipy_market_group g
     SET read_up_to = (SELECT max(posted_at) FROM ipy_market_post_seen s
                        WHERE s.group_name = g.name AND s.posted_at <= now() + interval '1 day')
   WHERE g.name = ANY (touched_groups);

  DROP FUNCTION pg_temp.market_true_date(timestamptz);
END
$repair$;
