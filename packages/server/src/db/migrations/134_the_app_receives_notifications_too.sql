-- One device list, whether the device is a browser or an installed app.
--
-- A phone running the native app cannot hold a Web Push subscription: there is
-- no service worker to deliver to. Its notifications arrive through Firebase on
-- Android and APNs on iPhone, addressed by a registration token rather than by
-- an endpoint URL and a keypair.
--
-- That token goes in this table rather than a second one. The alternative was
-- two lists of devices, two fan-outs, two places to delete a device from and
-- two answers to "why did that person not get the alert" — and the shape of
-- that mistake has already cost this codebase real time.
--
-- The token is stored in `endpoint` prefixed `fcm:`, which keeps the UNIQUE
-- constraint doing exactly the job it already did: one row per device, and a
-- re-register updates in place instead of piling up.

ALTER TABLE ipy_push_subscription
  -- A registration token has no key exchange, so these two are empty for an
  -- app. They stay NOT NULL for browsers by the check below rather than by the
  -- column, because a browser subscription without them is useless and should
  -- still be refused.
  ALTER COLUMN p256dh DROP NOT NULL,
  ALTER COLUMN auth   DROP NOT NULL;

ALTER TABLE ipy_push_subscription
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web';

-- Half-filled rows are the thing to prevent: a browser row missing its keys
-- fails at send time, silently, weeks later. Either it is an app token with no
-- keys, or it is a browser subscription with both.
ALTER TABLE ipy_push_subscription
  DROP CONSTRAINT IF EXISTS push_subscription_shape;
ALTER TABLE ipy_push_subscription
  ADD CONSTRAINT push_subscription_shape CHECK (
    (platform = 'web' AND p256dh IS NOT NULL AND auth IS NOT NULL)
    OR (platform IN ('android', 'ios'))
  );

-- Where an admin pastes the Firebase service account. Same shape as the
-- `web_push` row beside it, so Admin → Integrations needs no special case.
--
-- Existence test rather than ON CONFLICT: the unique index is on
-- (provider, label), not provider alone, so an inference clause naming only
-- provider fails with 42P10 — which reads like a missing constraint rather
-- than the wrong one. Migration 088 records the same trap.
INSERT INTO ipy_integration (provider, kind, label, is_active, credentials)
SELECT 'fcm', 'push', 'App notifications (Firebase)', false, '{}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM ipy_integration WHERE provider = 'fcm');
