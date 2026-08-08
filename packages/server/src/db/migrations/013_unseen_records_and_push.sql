-- ===========================================================================
-- iPropy CRM — 013: per-user "new record" state, and Web Push subscriptions
--
-- 1. Unseen records
--    A lead that arrived while you were away should stand out the way an
--    unread email does. "Have I opened this?" was already recorded in
--    ipy_recent_view (written whenever a record detail is fetched), so the
--    only missing piece is a per-module watermark: without one, the first
--    login on an existing database would mark all 180 historical leads new.
--
--    A record counts as new for a user when it was created after that user's
--    watermark AND they have never opened it. "Mark all as seen" moves the
--    watermark rather than writing a row per record.
--
-- 2. Web Push
--    Subscriptions are per browser/device, not per user, so one person may
--    hold several (laptop Chrome, Android Chrome, iOS home-screen PWA). The
--    endpoint is the natural key — the browser reissues the same one for a
--    given device+origin, so re-subscribing must not accumulate duplicates.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ipy_module_seen (
  user_id      UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  module_name  TEXT NOT NULL,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, module_name)
);

CREATE TABLE IF NOT EXISTS ipy_push_subscription (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES ipy_user(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bumped on every successful send; lets a cleanup job retire dead devices.
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_sub_user ON ipy_push_subscription(user_id);

-- The VAPID keypair identifies this server to the push services. Generated on
-- first use and stored here so every process in a deployment shares one pair —
-- rotating it silently invalidates every existing subscription.
INSERT INTO ipy_integration (provider, kind, label)
VALUES ('web_push', 'messaging', 'Browser Push Notifications')
ON CONFLICT (provider, label) DO NOTHING;
