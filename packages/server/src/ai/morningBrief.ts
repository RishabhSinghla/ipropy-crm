/**
 * Everybody's day, on their phone, at nine.
 *
 * The information already exists. The daily digest computes overdue follow-ups,
 * what is due today, the hot leads and the headline numbers, and it renders on
 * a dashboard nobody opens. A rep's morning starts on a phone, and whatever is
 * not on that phone at nine did not happen.
 *
 * So it goes out through `notify()`, which is the CRM's one way of reaching
 * somebody: a row in the bell, a socket ping, and a Web Push to whichever
 * devices they have subscribed. Not WhatsApp — a business-initiated WhatsApp is
 * a template message Meta charges for, per person per day, to say something the
 * phone can already show for nothing.
 *
 * Every part of it degrades. No model, and it is still an accurate list of
 * numbers written by hand. No push subscription, and it is still in the bell.
 */
import { complete } from './client.js';
import { dailyDigest } from './assistant.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { notify } from '../core/notifications/index.js';
import { buildScopeContext } from '../core/permissions/index.js';
import { featureOn } from '../core/settings/aiFeatures.js';
import { modelFor } from '../core/settings/aiModels.js';
import { organisationTimezone } from '../core/settings/timezone.js';
import type { AuthUser } from '@ipropy/shared';

/** Sent once a day, at this hour, in the organisation's own timezone. */
const HOUR = 9;

/**
 * Has it already gone out today?
 *
 * Read from the notifications themselves rather than from a marker table. The
 * question "did this person get their brief today" has exactly one honest
 * source, and it is the thing that was or was not sent.
 */
async function alreadySent(userId: string, day: string): Promise<boolean> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_notification
      WHERE user_id = $1 AND kind = 'morning_brief'
        AND created_at >= $2::date AND created_at < $2::date + interval '1 day'
      LIMIT 1`,
    [userId, day],
  );
  return Boolean(row);
}

function plainBrief(digest: NonNullable<Awaited<ReturnType<typeof dailyDigest>>>): string {
  const bits = [
    digest.stats.dueToday ? `${digest.stats.dueToday} due today` : '',
    digest.stats.overdueFollowups ? `${digest.stats.overdueFollowups} overdue` : '',
    digest.stats.openLeads ? `${digest.stats.openLeads} open leads` : '',
  ].filter(Boolean);
  const first = digest.priorities?.[0];
  return [
    bits.join(', ') || 'Nothing is overdue and nothing is due today.',
    first ? `Start with ${first.title}${first.reason ? ` — ${first.reason}` : ''}.` : '',
  ].filter(Boolean).join(' ');
}

async function briefFor(user: AuthUser): Promise<void> {
  const scope = await buildScopeContext(user);
  const ctx = { ...scope, user };
  const digest = await dailyDigest(ctx).catch(() => null);
  if (!digest) return;

  const quiet = !digest.stats.dueToday
    && !digest.stats.overdueFollowups
    && !(digest.priorities?.length);
  // A notification that says "nothing to do" every morning teaches people to
  // dismiss the notification, and then the one that matters is dismissed too.
  if (quiet) return;

  const written = await complete({
    feature: 'morning_brief',
    model: await modelFor('copy'),
    system: 'You write a one-paragraph morning brief for a property salesperson. Plain British '
      + 'English. Name records and numbers from the data given and nothing else. Never invent a '
      + 'name, a figure or a next step.',
    prompt: [
      `Good morning brief for ${user.fullName}.`,
      '',
      `Numbers: ${JSON.stringify(digest.stats)}`,
      '',
      'On their plate:',
      ...(digest.priorities ?? []).slice(0, 6)
        .map((p) => `- ${p.title}${p.reason ? ` (${p.reason})` : ''}`),
      '',
      'Write two or three short sentences. Lead with the single most urgent thing and say why. '
      + 'No greeting, no sign-off, no bullet points.',
    ].join('\n'),
    maxTokens: 400,
    temperature: 0.3,
    userId: user.id,
    fast: true,
  });

  await notify({
    userId: user.id,
    kind: 'morning_brief',
    title: 'Your day',
    body: written?.text.trim() || plainBrief(digest),
    link: '/dashboard',
  });
}

/**
 * Send whoever has not had theirs yet today.
 *
 * Called from the scheduler every minute, and does nothing for all but a few of
 * those minutes. Cheap enough to run that often, and running it that often is
 * what makes it survive a restart at 08:59.
 */
export async function sendMorningBriefs(): Promise<number> {
  if (!await featureOn('morningBrief')) return 0;

  const zone = await organisationTimezone();
  const now = new Date();
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string => local.find((p) => p.type === type)?.value ?? '';
  const hour = Number(part('hour'));
  if (hour !== HOUR) return 0;
  const day = `${part('year')}-${part('month')}-${part('day')}`;

  const { rows } = await db.query<{
    id: string; email: string; first_name: string; last_name: string;
    is_admin: boolean; role_id: string | null; profile_id: string | null;
  }>(
    `SELECT id, email, first_name, last_name, is_admin, role_id, profile_id
       FROM ipy_user
      WHERE is_active = true AND deleted_at IS NULL
      ORDER BY created_at
      LIMIT 100`,
  );

  let sent = 0;
  for (const row of rows) {
    if (await alreadySent(row.id, day)) continue;
    const user: AuthUser = {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName: `${row.first_name} ${row.last_name}`.trim(),
      avatarUrl: null,
      phone: null,
      isAdmin: row.is_admin,
      isActive: true,
      roleId: row.role_id,
      roleName: null,
      profileId: row.profile_id,
      profileName: null,
      groupIds: [],
      timezone: zone,
      locale: 'en-IN',
      currency: 'INR',
      theme: 'system',
      defaultDashboardId: null,
      lastLoginAt: null,
    };
    try {
      await briefFor(user);
      sent += 1;
    } catch (err) {
      // One person's brief failing must not cost everybody else theirs.
      logger.warn({ err, userId: row.id }, 'morning brief failed for one user');
    }
  }
  if (sent) logger.info({ sent }, 'morning briefs sent');
  return sent;
}
