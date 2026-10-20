-- 20 October 2026, the owner: the Dealer groups page showed deals "two years old".
--
-- The cause: WhatsApp exports from an American-set phone write the month first
-- ("10/20/26"), and the reader assumed the day first, so "10/20/26" became the
-- 10th day of the 20th month: July 2027 or later. Every deal read from the 22
-- chats dropped between 11:11 and 13:00 UTC that day got a date in 2026–2028,
-- the 45-day filter only looked backwards, and a post dated 2028 passed it.
-- The reader now works the order out from the file (readPost.ts, dateOrderOf).
--
-- This puts back what that did. Every sighting those imports wrote has a date that
-- is a deterministic misreading of the real one (those files were all month-first),
-- so it is turned back rather than guessed. A sighting is "theirs" when its row was
-- written by a transaction at or after the first of those imports (xmin) and its
-- group is one of the 22 — earlier, correct sightings of the same groups are left alone.
--
-- Safe to run on any database: with no import in that window it does nothing.
DO $repair$
DECLARE
  window_start CONSTANT timestamptz := '2026-10-20 11:00+00';
  window_end   CONSTANT timestamptz := '2026-10-20 13:30+00';
  touched_groups text[];
  threshold bigint;
BEGIN
  SELECT array_agg(DISTINCT group_name) INTO touched_groups
    FROM ipy_market_import
   WHERE created_at BETWEEN window_start AND window_end AND status <> 'duplicate';
  SELECT min(xmin::text::bigint) INTO threshold
    FROM ipy_market_post WHERE created_at BETWEEN window_start AND window_end;
  IF touched_groups IS NULL OR threshold IS NULL THEN
    RETURN;
  END IF;

  -- "10/20/26 4:32 PM" was stored as 2026-01-01 + (20 - 1) months + 10 days. Undo that:
  -- the day of the stored date is the real month, and its month counted from January 2026 is the real day.
  CREATE FUNCTION pg_temp.market_true_date(posted timestamptz) RETURNS timestamptz LANGUAGE plpgsql AS $fn$
  DECLARE
    local_time timestamp := posted AT TIME ZONE 'Asia/Kolkata';
    real_month int := extract(day FROM local_time)::int;
    real_day   int := (extract(year FROM local_time)::int - 2026) * 12 + extract(month FROM local_time)::int;
    answer timestamptz;
  BEGIN
    answer := make_timestamptz(2026, real_month, real_day,
                               extract(hour FROM local_time)::int, extract(minute FROM local_time)::int, 0, 'Asia/Kolkata');
    -- These files hold nothing from before 21 August 2026 and nothing from the future.
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
   WHERE s.group_name = ANY (touched_groups) AND s.posted_at IS NOT NULL AND s.xmin::text::bigint >= threshold;

  -- A sighting whose real date already exists (the same message read correctly before) is a duplicate: drop it.
  DELETE FROM ipy_market_post_seen s USING market_bad_seen b
   WHERE s.ctid = b.row_id AND b.true_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM ipy_market_post_seen o
                  WHERE o.post_id = b.post_id AND o.group_name = b.group_name AND o.sender = b.sender AND o.posted_at = b.true_at);
  -- One that cannot be turned back and lies in the future is plainly wrong: drop it too.
  DELETE FROM ipy_market_post_seen s USING market_bad_seen b
   WHERE s.ctid = b.row_id AND b.true_at IS NULL AND b.posted_at > now() + interval '1 day';

  BEGIN
    UPDATE ipy_market_post_seen s SET posted_at = b.true_at
      FROM market_bad_seen b WHERE s.ctid = b.row_id AND b.true_at IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    -- Two sightings of one message by one sender landing on the same minute: keep what is already right.
    DELETE FROM ipy_market_post_seen s USING market_bad_seen b WHERE s.ctid = b.row_id AND b.true_at IS NOT NULL;
  END;

  -- Every deal that had such a sighting takes its first and last dates from what is left.
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
  -- Whatever still claims to be from the future has no date it can stand on: say it arrived when it was stored.
  UPDATE ipy_market_post SET last_posted_at = least(created_at, now()) WHERE last_posted_at > now() + interval '1 day';
  UPDATE ipy_market_post SET first_posted_at = least(created_at, now()) WHERE first_posted_at > now() + interval '1 day';

  -- The note each deal left on its dealer's Associate record carries the date twice: when it was written
  -- and in its first line. Both follow the deal.
  UPDATE ipy_comment c
     SET created_at = p.first_posted_at,
         body = regexp_replace(c.body, E'^(💬 WhatsApp · [^\\n]*) · [^\\n·]*\\n',
                               E'\\1 · ' || to_char(p.first_posted_at AT TIME ZONE 'Asia/Kolkata', 'FMDD Mon YYYY') || E'\n')
    FROM ipy_market_post p
   WHERE c.market_post_id = p.id AND p.first_posted_at IS NOT NULL
     AND p.id IN (SELECT post_id FROM market_fixed_posts);

  -- "Read up to here" was pushed into the future, which would have made the next upload skip real news.
  UPDATE ipy_market_group g
     SET read_up_to = (SELECT max(posted_at) FROM ipy_market_post_seen s
                        WHERE s.group_name = g.name AND s.posted_at <= now() + interval '1 day')
   WHERE g.name = ANY (touched_groups);
END
$repair$;
