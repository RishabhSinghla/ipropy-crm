/**
 * One way to notify a person.
 *
 * `INSERT INTO ipy_notification` once appeared verbatim in nine places
 * (workflow tasks, the scheduler, telephony, lead capture, WhatsApp, AI
 * actions, webhooks, comms, records). That was fine while a notification was
 * only a row, but the moment it also has to reach a phone that isn't looking at
 * the CRM, nine copies means nine places to forget — and eight of them did, so
 * an SLA breach, a website enquiry, a repeat enquiry, an @mention and a
 * finished import all wrote a row nobody saw until they next opened the app.
 * This is now the only writer; everything funnels here:
 *
 *   row in ipy_notification  →  socket ping to open tabs  →  Web Push to devices
 *
 * Push is best-effort and never blocks the caller's work — a lead must still be
 * created when Google's push service is having a bad day.
 */
import webpush from 'web-push';
import { config } from '../../config.js';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { pushNotification } from '../../realtime.js';

export interface NotifyInput {
  userId: string;
  /** short machine tag: 'new_lead', 'workflow', 'call', 'whatsapp'… */
  kind: string;
  title: string;
  body?: string | null;
  /** in-app route, e.g. `/leads/<id>` */
  link?: string | null;
  recordId?: string | null;
  /** skip the browser push for low-value chatter; the row is still written */
  silent?: boolean;
}

export async function notify(input: NotifyInput, conn: Tx = db): Promise<void> {
  const row = await conn.queryOne<{ id: string; created_at: string }>(
    `INSERT INTO ipy_notification (user_id, kind, title, body, link, record_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [input.userId, input.kind, input.title, input.body ?? null, input.link ?? null, input.recordId ?? null],
  );
  if (!row) return;

  pushNotification(input.userId, {
    id: row.id, kind: input.kind, title: input.title,
    body: input.body ?? null, link: input.link ?? null, createdAt: row.created_at,
  });

  if (!input.silent) {
    // Deliberately not awaited: a slow or dead push endpoint must not hold up
    // the transaction that produced the notification.
    void sendPush(input).catch((err) => logger.debug({ err }, 'web push failed'));
  }
}

/** Notify several people with the same message. */
export async function notifyMany(userIds: string[], input: Omit<NotifyInput, 'userId'>, conn: Tx = db): Promise<void> {
  for (const userId of new Set(userIds)) await notify({ ...input, userId }, conn);
}

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

interface VapidKeys { publicKey: string; privateKey: string }

let cachedVapid: VapidKeys | null = null;

/**
 * The VAPID keypair identifies this server to Google/Mozilla/Apple's push
 * services. Generated once and persisted, because rotating it silently
 * invalidates every subscription already handed out — so it must survive a
 * restart and be shared by every process in a deployment.
 */
export async function getVapidKeys(): Promise<VapidKeys | null> {
  if (cachedVapid) return cachedVapid;

  if (config.push.publicKey && config.push.privateKey) {
    cachedVapid = { publicKey: config.push.publicKey, privateKey: config.push.privateKey };
    return cachedVapid;
  }

  const row = await db.queryOne<{ credentials: { publicKey?: string; privateKey?: string } }>(
    `SELECT credentials FROM ipy_integration WHERE provider = 'web_push'`,
  );
  const stored = row?.credentials;
  if (stored?.publicKey && stored?.privateKey) {
    cachedVapid = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    return cachedVapid;
  }

  return null;
}

/** Create and persist a keypair. Safe to call concurrently — first writer wins. */
export async function ensureVapidKeys(): Promise<VapidKeys> {
  const existing = await getVapidKeys();
  if (existing) return existing;

  const generated = webpush.generateVAPIDKeys();
  // WHERE credentials = '{}' so a racing process that already wrote a pair is
  // not overwritten — that would invalidate whatever it just handed out.
  await db.query(
    `UPDATE ipy_integration
     SET credentials = $1::jsonb, is_active = true, updated_at = now()
     WHERE provider = 'web_push' AND (credentials IS NULL OR credentials = '{}'::jsonb)`,
    [JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey })],
  );

  cachedVapid = null;
  return (await getVapidKeys()) ?? generated;
}

interface SubscriptionRow {
  id: string; endpoint: string; p256dh: string | null; auth: string | null; platform: string;
}

/**
 * The prefix that marks a row as an installed app rather than a browser.
 *
 * App tokens share this table deliberately — one device list, one fan-out, one
 * place a device is deleted from. Two of each is how "why did that person not
 * get the alert" becomes unanswerable.
 */
const FCM_PREFIX = 'fcm:';

async function sendPush(input: NotifyInput): Promise<void> {
  const subs = await db.query<SubscriptionRow>(
    `SELECT id, endpoint, p256dh, auth, platform FROM ipy_push_subscription WHERE user_id = $1`,
    [input.userId],
  );
  if (!subs.rows.length) return;

  const browsers = subs.rows.filter((s) => !s.endpoint.startsWith(FCM_PREFIX));
  const apps = subs.rows.filter((s) => s.endpoint.startsWith(FCM_PREFIX));

  await Promise.all([sendToBrowsers(input, browsers), sendToApps(input, apps)]);
}

/**
 * The installed app, through Firebase.
 *
 * Kept beside the browser fan-out rather than inside it because the two fail
 * differently and must not take each other down: a missing Firebase account is
 * normal and silent, while a missing VAPID pair means browser push was never
 * set up. Neither is a reason for the other's devices to go unnotified.
 */
async function sendToApps(input: NotifyInput, subs: SubscriptionRow[]): Promise<void> {
  if (!subs.length) return;
  const { sendFcm } = await import('./fcm.js');

  await Promise.all(subs.map(async (sub) => {
    const outcome = await sendFcm(sub.endpoint.slice(FCM_PREFIX.length), {
      title: input.title,
      body: input.body ?? '',
      link: input.link ?? '/',
      kind: input.kind,
      tag: input.recordId ?? input.kind,
    }).catch(() => 'failed' as const);

    if (outcome === 'sent') {
      await db.query(`UPDATE ipy_push_subscription SET last_used_at = now() WHERE id = $1`, [sub.id]);
    } else if (outcome === 'expired') {
      // The app was uninstalled or the token rotated. Keeping the row retries a
      // dead handset on every notification for ever.
      await db.query(`DELETE FROM ipy_push_subscription WHERE id = $1`, [sub.id]);
      logger.debug({ platform: sub.platform }, 'removed expired app push token');
    }
  }));
}

async function sendToBrowsers(input: NotifyInput, subs: SubscriptionRow[]): Promise<void> {
  if (!subs.length) return;
  const keys = await getVapidKeys();
  if (!keys) return; // push not set up yet — the in-app notification still landed

  webpush.setVapidDetails(config.push.subject, keys.publicKey, keys.privateKey);

  const payload = JSON.stringify({
    title: input.title,
    body: input.body ?? '',
    // The service worker opens this; relative so it works on any deployment host.
    link: input.link ?? '/',
    kind: input.kind,
    tag: input.recordId ?? input.kind,
  });

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh ?? '', auth: sub.auth ?? '' } },
        payload,
      );
      await db.query(`UPDATE ipy_push_subscription SET last_used_at = now() WHERE id = $1`, [sub.id]);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 mean the browser threw the subscription away (uninstalled PWA,
      // cleared site data, permission revoked). Keeping it would retry a dead
      // endpoint on every notification forever.
      if (status === 404 || status === 410) {
        await db.query(`DELETE FROM ipy_push_subscription WHERE id = $1`, [sub.id]);
        logger.debug({ endpoint: sub.endpoint.slice(0, 60) }, 'removed expired push subscription');
      } else {
        logger.warn({ err, status }, 'push send failed');
      }
    }
  }));
}

export async function savePushSubscription(input: {
  userId: string; endpoint: string; p256dh?: string | null; auth?: string | null;
  userAgent?: string; platform?: 'web' | 'android' | 'ios';
}): Promise<void> {
  // The browser reissues the same endpoint for a given device+origin, so a
  // re-subscribe must update rather than pile up rows — and must re-point the
  // row if a different user signs in on that device.
  await db.query(
    `INSERT INTO ipy_push_subscription (user_id, endpoint, p256dh, auth, user_agent, platform)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent,
           platform = EXCLUDED.platform`,
    [
      input.userId, input.endpoint, input.p256dh ?? null, input.auth ?? null,
      input.userAgent ?? null, input.platform ?? 'web',
    ],
  );
}

/**
 * Register the installed app on this device to receive notifications.
 *
 * The token is stored with an `fcm:` prefix so it shares the UNIQUE endpoint
 * constraint with browser subscriptions — one row per device, and re-opening
 * the app updates in place rather than piling up a row per launch.
 */
export async function saveAppPushToken(input: {
  userId: string; token: string; platform: 'android' | 'ios'; label?: string;
}): Promise<void> {
  await savePushSubscription({
    userId: input.userId,
    endpoint: `fcm:${input.token}`,
    platform: input.platform,
    userAgent: input.label ?? `iPropy app (${input.platform})`,
  });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await db.query(`DELETE FROM ipy_push_subscription WHERE endpoint = $1`, [endpoint]);
}
