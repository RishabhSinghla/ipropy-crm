/**
 * One stage field, kept in two places, without anybody having to remember.
 *
 * Leads carry two overlapping ideas of "where is this person up to":
 *
 *   Lead Status      New, Attempted Contact, Contacted, Qualified,
 *                    Site Visit Scheduled, Site Visit Done, Negotiation,
 *                    Converted, Junk, Lost           — the sales pipeline
 *   Lifecycle Stage  Lead, Prospect, Customer, Past Customer
 *                                                    — the relationship
 *
 * Both are genuinely useful and both were editable by hand, which made them two
 * facts about one thing that a busy rep had to keep in agreement. They never
 * stayed in agreement. Somebody would move a lead to Converted and leave the
 * Lifecycle on Lead, and every report grouped by relationship would then be
 * wrong in a way nobody could see.
 *
 * The owner's first instinct was to delete one of them, and he was right that
 * two fields is one too many *to fill in*. He is not right that either is
 * redundant: WhatsApp and telephony rank an inbound match by lifecycle so a
 * customer's call finds their record before a two-year-old enquiry does, while
 * the pipeline board, scoring and the follow-up rules all key off status. Delete
 * either and something real stops.
 *
 * So they merge rather than one being removed. **Status is the one a person
 * sets. Lifecycle follows it**, through a mapping an admin owns, and the field
 * goes read-only so the two can no longer disagree.
 *
 * Two rules make the mapping safe:
 *
 *  * **Forward only.** `advanceLifecycle` refuses to move a record backwards, so
 *    a customer who sends a fresh enquiry stays a Customer while their new
 *    status runs from New again. Losing that would quietly demote every repeat
 *    buyer in the database.
 *  * **A status with no mapping changes nothing.** Junk and Lost say how an
 *    enquiry ended, not what the person is. Somebody who bought a floor last
 *    year and whose latest enquiry went nowhere is still a Customer.
 */
import type { AuthUser } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { bus, type RecordEventPayload } from '../events/bus.js';
import { registry } from '../metadata/registry.js';
import { advanceLifecycle } from './conversion.js';

/** The setting an admin edits. Blank or unreadable falls back to this. */
export const DEFAULT_STAGE_MAP: Record<string, string> = {
  New: 'Lead',
  'Attempted Contact': 'Lead',
  Contacted: 'Lead',
  Qualified: 'Prospect',
  'Site Visit Scheduled': 'Prospect',
  'Site Visit Done': 'Prospect',
  Negotiation: 'Prospect',
  Converted: 'Customer',
  // Junk and Lost are deliberately absent — see the note above.
};

const SETTING_KEY = 'leads.stage_from_status';

let cached: Record<string, string> | null = null;

export function invalidateStageMap(): void {
  cached = null;
}

export async function stageMap(): Promise<Record<string, string>> {
  if (cached) return cached;
  try {
    const row = await db.queryOne<{ value: unknown }>(
      `SELECT value FROM ipy_setting WHERE key = $1`, [SETTING_KEY],
    );
    const raw = row?.value;
    // Every entry has to be a string pair. One bad entry drops that entry rather
    // than the whole map, so a typo costs one status and not the feature.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const clean: Record<string, string> = {};
      for (const [status, stage] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof stage === 'string' && stage.trim()) clean[status] = stage.trim();
      }
      cached = clean;
      return clean;
    }
  } catch (err) {
    logger.warn({ err }, 'could not read the lead stage map, using the shipped one');
  }
  cached = DEFAULT_STAGE_MAP;
  return cached;
}

/**
 * Put the lifecycle where the status says it should be.
 *
 * Resolves both fields through the registry by their storage column rather than
 * their API name, so renaming either — which an admin may now do — does not
 * quietly stop the two staying in step.
 */
export async function syncLifecycle(
  recordId: string,
  values: Record<string, unknown>,
  actor: AuthUser | null = null,
): Promise<void> {
  const module = await registry.getModule('leads');
  if (!module) return;

  const statusField = registry.fieldPlaying(module, 'status');
  const stageField = registry.fieldPlaying(module, 'lifecycle_stage');
  // Either one removed and there is nothing to keep in step. Not an error: an
  // admin is allowed to run this CRM without a lifecycle at all.
  if (!statusField || !stageField) return;

  const status = values[statusField.name];
  if (typeof status !== 'string' || !status) return;

  const target = (await stageMap())[status];
  if (!target) return;

  const { systemContext } = await import('../workflow/tasks.js');
  await advanceLifecycle(await systemContext(actor), recordId, target as Parameters<typeof advanceLifecycle>[2]);
}

/**
 * Wired next to the workflow handlers, and deliberately after them: a workflow
 * that sets the status should get the lifecycle move too.
 *
 * `advanceLifecycle` writes with `skipWorkflow`, so this cannot re-enter.
 */
export function registerLifecycleSync(): void {
  const handle = async (p: RecordEventPayload): Promise<void> => {
    if (p.module !== 'leads') return;
    try {
      await syncLifecycle(p.recordId, p.record, p.user ?? null);
    } catch (err) {
      // Never take a lead write down over this. The stage being one step behind
      // is a smaller problem than a save that failed.
      logger.warn({ err, recordId: p.recordId }, 'could not sync lifecycle from status');
    }
  };

  bus.on('record.created', handle);
  bus.on('record.updated', async (p: RecordEventPayload) => {
    const module = await registry.getModule('leads');
    const statusField = module ? registry.fieldPlaying(module, 'status') : null;
    // Only when the status actually moved. Every other edit on a lead would
    // otherwise re-run this for nothing.
    if (statusField && p.changedFields?.includes(statusField.name)) await handle(p);
  });
}
