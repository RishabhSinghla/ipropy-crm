/**
 * Is this deployment actually ready for a team, or does it only look ready?
 *
 * Going live is not a code problem — the CRM has been finished for days — it is
 * six pieces of configuration spread across a database host, a hosting
 * dashboard, an admin screen and everybody's phone. That list lives in
 * somebody's head or in a document, and a document cannot tell you whether the
 * thing was actually done. It says what you intended.
 *
 * So the CRM checks itself. Each item below is something the running server can
 * genuinely observe about its own deployment, and the two it cannot see are
 * reported as unknown rather than guessed — an amber "I cannot tell you" is
 * worth something; a green tick that means "nobody checked" is worth less than
 * nothing, because it is the reason people stop reading checklists.
 *
 * **No secrets leave this module.** A key is reported as set or not set, never
 * echoed, not even partially. This is an admin screen, but an admin screen is
 * still a screenshot away from a group chat.
 */
import { config } from '../config.js';
import { db } from '../db/pool.js';
import { getSettings } from './settings/integrations.js';

export type ReadinessStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface ReadinessCheck {
  id: string;
  title: string;
  status: ReadinessStatus;
  /** What is true right now, in a sentence. */
  detail: string;
  /** What to do about it, when it is not ok. */
  fix?: string;
}

export async function readinessReport(): Promise<{
  checks: ReadinessCheck[];
  readyCount: number;
  total: number;
}> {
  const checks = [
    photosSurviveDeploys(),
    await realTeamAccounts(),
    await demoAccountsClosed(),
    await alertsReachPhones(),
    await sendingChannels(),
    staysAwake(),
    backupsAreOnSomewhereElse(),
  ];

  return {
    checks,
    readyCount: checks.filter((c) => c.status === 'ok').length,
    total: checks.length,
  };
}

/**
 * The one that loses work silently.
 *
 * A free hosting instance has no persistent disk, so `local` means every deploy
 * rebuilds the container and takes the uploaded photos with it. Nobody gets an
 * error; the files are simply gone, and the first person to notice is a buyer
 * looking at an empty gallery.
 */
function photosSurviveDeploys(): ReadinessCheck {
  const { driver, s3 } = config.storage;
  if (driver === 'local') {
    return {
      id: 'storage',
      title: 'Uploaded photos survive an update',
      status: 'fail',
      detail: 'Storage is set to the container\'s own disk. If this deployment has no permanent disk, every update deletes every uploaded photo and video.',
      fix: 'Set up Cloudflare R2 (free), fill in the four S3_* variables and change STORAGE_DRIVER to s3 — DEPLOYMENT.md §2.',
    };
  }
  if (driver === 's3') {
    const missing = ([
      ['S3_BUCKET', s3.bucket],
      ['S3_ACCESS_KEY_ID', s3.accessKeyId],
      ['S3_SECRET_ACCESS_KEY', s3.secretAccessKey],
    ] as const).filter(([, value]) => !value).map(([name]) => name);

    if (missing.length) {
      return {
        id: 'storage',
        title: 'Uploaded photos survive an update',
        status: 'fail',
        detail: `Storage is set to s3 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty, so uploads will fail or fall back to disk.`,
        fix: 'Fill in the missing variables in the hosting dashboard and redeploy.',
      };
    }
    return {
      id: 'storage',
      title: 'Uploaded photos survive an update',
      status: 'ok',
      detail: `Files go to ${s3.bucket}, outside this server, so a deploy cannot take them.`,
    };
  }
  return {
    id: 'storage',
    title: 'Uploaded photos survive an update',
    status: 'ok',
    detail: 'Files go to OneDrive, outside this server.',
  };
}

/** A CRM with one account is a CRM nobody else is using. */
async function realTeamAccounts(): Promise<ReadinessCheck> {
  const row = await db.queryOne<{ real: string; seeded: string }>(
    `SELECT count(*) FILTER (WHERE email NOT LIKE '%@ipropy.com') AS real,
            count(*) FILTER (WHERE email LIKE '%@ipropy.com')     AS seeded
     FROM ipy_user WHERE is_active = true`,
  );
  const real = Number(row?.real ?? 0);
  if (real >= 2) {
    return {
      id: 'team',
      title: 'Your team has their own logins',
      status: 'ok',
      detail: `${real} real accounts are active.`,
    };
  }
  return {
    id: 'team',
    title: 'Your team has their own logins',
    status: real === 1 ? 'warn' : 'fail',
    detail: real === 1
      ? 'Only one real account exists — presumably yours.'
      : 'No real accounts exist yet.',
    fix: 'Admin → Users to add each person, then Admin → Workflows → Assignment rules to decide who new enquiries go to.',
  };
}

/**
 * The demo accounts share a password that is published in this repository.
 *
 * Harmless while nobody knows the address, and an open door the moment a real
 * team is using it — which is exactly when nobody is thinking about them.
 */
async function demoAccountsClosed(): Promise<ReadinessCheck> {
  const row = await db.queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM ipy_user
     WHERE is_active = true AND email LIKE '%@ipropy.com' AND email <> $1`,
    [config.seed.adminEmail ?? 'admin@ipropy.com'],
  );
  const left = Number(row?.n ?? 0);
  if (!left) {
    return {
      id: 'demo_users',
      title: 'Demo accounts are switched off',
      status: 'ok',
      detail: 'No leftover demo logins are active.',
    };
  }
  return {
    id: 'demo_users',
    title: 'Demo accounts are switched off',
    status: 'fail',
    detail: `${left} demo account${left === 1 ? '' : 's'} can still sign in, and they share a password that is published in this repository.`,
    fix: 'Admin → Users → deactivate every account ending in @ipropy.com except your own.',
  };
}

/**
 * Alerts that reach nobody.
 *
 * Every alert the CRM raises — a new enquiry, a buyer matching new stock, a
 * call to file — is written to a row and pushed to a device. With no device
 * subscribed, the push half lands nowhere and the whole feature quietly
 * becomes a bell icon somebody has to remember to check.
 */
async function alertsReachPhones(): Promise<ReadinessCheck> {
  const row = await db.queryOne<{ devices: string; people: string }>(
    `SELECT count(*) AS devices, count(DISTINCT user_id) AS people FROM ipy_push_subscription`,
  );
  const devices = Number(row?.devices ?? 0);
  const people = Number(row?.people ?? 0);
  if (devices > 0) {
    return {
      id: 'push',
      title: 'Alerts reach phones',
      status: 'ok',
      detail: `${devices} device${devices === 1 ? '' : 's'} across ${people} ${people === 1 ? 'person' : 'people'}.`,
    };
  }
  return {
    id: 'push',
    title: 'Alerts reach phones',
    status: 'fail',
    detail: 'No device is set up, so every alert waits in the bell icon for somebody to look.',
    fix: 'Each person: Settings → Alerts → Turn on alerts, once per device. On iPhone, add iPropy to the Home Screen first — Apple does not allow this from Safari.',
  };
}

/** Can the CRM answer an enquiry by itself, or does a person have to? */
async function sendingChannels(): Promise<ReadinessCheck> {
  const settings = getSettings();
  const whatsapp = Boolean(settings.whatsapp?.accessToken);
  const email = Boolean(settings.email?.host);

  if (whatsapp && email) {
    return {
      id: 'channels',
      title: 'The CRM can send on its own',
      status: 'ok',
      detail: 'WhatsApp and email are both connected.',
    };
  }
  const queued = await db.queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM ipy_device_send WHERE status IN ('pending','opened')`,
  );
  return {
    id: 'channels',
    title: 'The CRM can send on its own',
    status: 'warn',
    detail: whatsapp || email
      ? `Only ${whatsapp ? 'WhatsApp' : 'email'} is connected.`
      : `Neither WhatsApp nor email is connected, so replies are written for a person to send. ${Number(queued?.n ?? 0)} waiting now.`,
    fix: 'This is not blocking — messages are queued for one-tap sending. Connect a WhatsApp Business account or an SMTP server when you have one.',
  };
}

/**
 * Whether this instance is being put to sleep.
 *
 * The server cannot read its own hosting plan, but it can read its own uptime,
 * and an instance that has been alive for eight minutes at eleven in the
 * morning is one that was asleep at 10:52. Reported as an observation rather
 * than a verdict, because a genuine restart looks the same from in here.
 */
function staysAwake(): ReadinessCheck {
  const minutes = Math.round(process.uptime() / 60);
  if (minutes >= 120) {
    return {
      id: 'awake',
      title: 'The server stays awake',
      status: 'ok',
      detail: `Up for ${Math.round(minutes / 60)} hours without a restart.`,
    };
  }
  return {
    id: 'awake',
    title: 'The server stays awake',
    status: 'unknown',
    detail: `This server started ${minutes} minute${minutes === 1 ? '' : 's'} ago. If that keeps happening during the day, it is being put to sleep between visits and the first person each morning waits half a minute.`,
    fix: 'On Render: the service → Settings → Instance Type → move off Free.',
  };
}

/**
 * The one thing that cannot be answered from in here.
 *
 * Backups are configured at the database host, and a running server has no way
 * to ask Neon whether a schedule exists. Saying "unknown" is the honest answer
 * and the useful one — the alternative is a check that quietly passes because
 * it never really looked.
 */
function backupsAreOnSomewhereElse(): ReadinessCheck {
  return {
    id: 'backups',
    title: 'The database is backed up',
    status: 'unknown',
    detail: 'Backups are configured at your database host, which this server cannot see. It is the only item here with no undo if it is wrong.',
    fix: 'Neon Console → Billing → Launch plan, then Settings → Instant restore (7 days) and Settings → Backups (daily). Confirm the Backups page shows a next run time.',
  };
}
