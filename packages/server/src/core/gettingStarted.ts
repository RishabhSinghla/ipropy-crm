/**
 * What is still missing before this CRM is somebody's working day.
 *
 * Deliberately not the go-live readiness report, which answers a different
 * question — that one is about the deployment (storage, backups, whether the
 * server sleeps) and its audience is whoever runs it. This is about the
 * *business*: is there anything in here, does it know who you are, has anybody
 * actually used it. A new owner needs the second list and cannot act on most
 * of the first.
 *
 * Every step is derived from real data. Nothing is remembered as "done",
 * because a checklist that stays ticked after somebody deletes their last lead
 * is telling them about the past. If a step comes back, it is because the
 * thing it describes came back.
 */
import { db } from '../db/pool.js';

export interface GettingStartedStep {
  id: string;
  title: string;
  /** Why it matters, in a sentence somebody non-technical would accept. */
  why: string;
  done: boolean;
  /** Where in the app to go and do it. */
  href: string;
  action: string;
  /** Admin-only steps are hidden from reps rather than shown as blocked. */
  adminOnly: boolean;
}

export async function gettingStarted(): Promise<{ steps: GettingStartedStep[]; doneCount: number }> {
  const one = async (sql: string): Promise<number> => {
    try {
      const row = await db.queryOne<{ n: string }>(sql);
      return Number(row?.n ?? 0);
    } catch {
      // A count that cannot be read must not take the dashboard down with it.
      return 0;
    }
  };

  const [leads, properties, users, followUps, notes, orgName] = await Promise.all([
    one(`SELECT count(*) AS n FROM ipy_record WHERE module_name='leads' AND is_deleted=false`),
    one(`SELECT count(*) AS n FROM ipy_record WHERE module_name='properties' AND is_deleted=false`),
    one(`SELECT count(*) AS n FROM ipy_user WHERE is_active=true AND email <> 'system@ipropy'`),
    one(`SELECT count(*) AS n FROM ipy_e_leads WHERE next_followup_at IS NOT NULL`),
    one(`SELECT count(*) AS n FROM ipy_comment`),
    one(`SELECT count(*) AS n FROM ipy_setting WHERE key='org.name' AND value #>> '{}' NOT IN ('', 'iPropy')`),
  ]);

  const steps: GettingStartedStep[] = [
    {
      id: 'org',
      title: 'Tell the CRM who you are',
      why: 'Your business name and address appear on everything it sends and on your public listings.',
      done: orgName > 0,
      href: '/admin/settings',
      action: 'Open settings',
      adminOnly: true,
    },
    {
      id: 'property',
      title: 'Add your first property',
      why: 'Inventory is what you match buyers against. Without one, matching and the website have nothing to show.',
      done: properties > 0,
      href: '/properties',
      action: 'Add a property',
      adminOnly: false,
    },
    {
      id: 'lead',
      title: 'Add your first lead',
      why: 'One real enquiry is enough to see scoring, matching and follow-ups actually work.',
      done: leads > 0,
      href: '/leads',
      action: 'Add a lead',
      adminOnly: false,
    },
    {
      id: 'follow_up',
      title: 'Set a follow-up on someone',
      why: 'This is the habit the CRM exists to enforce. A lead with no next date is a lead you will forget.',
      done: followUps > 0,
      href: '/leads',
      action: 'Open a lead',
      adminOnly: false,
    },
    {
      id: 'note',
      title: 'Leave a note on a record',
      why: 'What was said on a call lives on the record, not in somebody’s head or their own phone.',
      done: notes > 0,
      href: '/leads',
      action: 'Open a lead',
      adminOnly: false,
    },
    {
      id: 'team',
      title: 'Invite your team',
      why: 'Each person needs their own login, so you can see who did what and who owns which lead.',
      done: users > 1,
      href: '/admin/users',
      action: 'Add a user',
      adminOnly: true,
    },
  ];

  return { steps, doneCount: steps.filter((s) => s.done).length };
}
