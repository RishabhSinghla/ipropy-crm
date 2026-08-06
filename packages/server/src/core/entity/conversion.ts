/**
 * Lead conversion.
 *
 * With Contacts merged into Leads, converting no longer copies a person into a
 * second module. The lead record *is* the customer record — conversion advances
 * its lifecycle stage and opens a Deal against it. Nothing moves, so the
 * timeline, conversations, calls and files stay on one id for the whole
 * relationship.
 */
import { onCommit, transaction, type Tx } from '../../db/pool.js';
import { BadRequestError, ConflictError } from '../../utils/errors.js';
import { emit } from '../events/bus.js';
import { registry } from '../metadata/registry.js';
import { createRecord, getRecord, updateRecord, type ServiceContext } from './recordService.js';

export interface ConvertOptions {
  createOrganization?: boolean;
  createDeal?: boolean;
  dealName?: string;
  dealAmount?: number;
  dealStage?: string;
  expectedCloseDate?: string;
  propertyId?: string;
  ownerId?: string;
  /** accepted for API compatibility; the lead already is the contact */
  createContact?: boolean;
}

export interface ConvertResult {
  /** the lead's own id — it is the customer record now */
  contactId: string;
  organizationId: string | null;
  dealId: string | null;
  leadId: string;
}

export async function convertLead(
  ctx: ServiceContext,
  leadId: string,
  opts: ConvertOptions = {},
): Promise<ConvertResult> {
  return transaction(async (tx) => {
    const lead = await getRecord({ ...ctx, system: true }, 'leads', leadId, { conn: tx, withDisplay: false });
    if (lead.values.is_converted) {
      throw new ConflictError('This record has already been converted', {
        dealId: lead.values.converted_deal_id,
      });
    }

    const v = lead.values;
    const ownerId = opts.ownerId ?? lead.ownerId ?? ctx.user.id;
    const sysCtx: ServiceContext = { ...ctx, system: true, source: 'conversion' };

    // --- Organisation -----------------------------------------------------
    // Still a separate module: a company is not a person, and several buyers
    // can belong to one.
    let organizationId: string | null = (v.organization_id as string) ?? null;
    if (opts.createOrganization && v.company && !organizationId) {
      const existing = await tx.queryOne<{ record_id: string }>(
        `SELECT o.record_id FROM ipy_e_organizations o
         JOIN ipy_record r ON r.id = o.record_id
         WHERE lower(o.name) = lower($1) AND r.is_deleted = false LIMIT 1`,
        [String(v.company)],
      );
      if (existing) {
        organizationId = existing.record_id;
      } else {
        const org = await createRecord(sysCtx, 'organizations', {
          name: v.company,
          phone: v.mobile,
          email: v.email,
          owner_id: ownerId,
        }, { conn: tx, skipDuplicateCheck: true });
        organizationId = org.id;
      }
    }

    // --- Deal -------------------------------------------------------------
    let dealId: string | null = null;
    if (opts.createDeal !== false) {
      const projectLabel = v.interested_project_id
        ? (await tx.queryOne<{ label: string }>(`SELECT label FROM ipy_record WHERE id = $1`, [v.interested_project_id]))?.label
        : null;
      const name = opts.dealName
        ?? `${[v.first_name, v.last_name].filter(Boolean).join(' ')}${projectLabel ? ` — ${projectLabel}` : ''}`;

      // Default the deal value to the stated budget ceiling — the realistic ask.
      const amount = opts.dealAmount ?? (v.budget_max as number | null) ?? (v.budget_min as number | null) ?? 0;

      const stage = opts.dealStage ?? 'Enquiry';
      const stageMeta = await tx.queryOne<{ meta: { probability?: number } }>(
        `SELECT pv.meta FROM ipy_picklist_value pv
         JOIN ipy_picklist p ON p.id = pv.picklist_id
         WHERE p.name = 'deal_stage' AND pv.value = $1`,
        [stage],
      );

      const deal = await createRecord(sysCtx, 'deals', {
        name,
        // The lead id *is* the buyer id.
        contact_id: leadId,
        organization_id: organizationId,
        project_id: v.interested_project_id,
        property_id: opts.propertyId ?? null,
        source_lead_id: leadId,
        channel_partner_id: v.channel_partner_id,
        campaign_id: v.campaign_id,
        stage,
        probability: stageMeta?.meta?.probability ?? 10,
        amount,
        expected_close_date: opts.expectedCloseDate ?? defaultCloseDate(String(v.possession_timeline ?? '')),
        lead_source: v.lead_source,
        stage_changed_at: new Date().toISOString(),
        description: v.description,
        owner_id: ownerId,
      }, { conn: tx, skipDuplicateCheck: true });
      dealId = deal.id;
    }

    // --- Advance the lead in place ---------------------------------------
    await updateRecord(sysCtx, 'leads', leadId, {
      is_converted: true,
      converted_at: new Date().toISOString(),
      converted_deal_id: dealId,
      converted_org_id: organizationId,
      organization_id: organizationId,
      status: 'Converted',
      lifecycle_stage: 'Prospect',
      contact_type: v.contact_type ?? 'Buyer',
    }, { conn: tx, skipWorkflow: true });

    // Deferred until COMMIT — handlers write on other connections and would
    // otherwise block on the rows this transaction still holds.
    onCommit(tx, () => emit('record.converted', {
      module: 'leads',
      recordId: leadId,
      record: lead.values,
      user: ctx.user,
      source: 'conversion',
      targets: {
        ...(dealId ? { deals: dealId } : {}),
        ...(organizationId ? { organizations: organizationId } : {}),
      },
    }));

    return { contactId: leadId, organizationId, dealId, leadId };
  });
}

/** Turn a stated timeline into a realistic expected close date. */
function defaultCloseDate(timeline: string): string {
  const days: Record<string, number> = {
    Immediate: 21,
    'Within 1 Month': 35,
    '1-3 Months': 75,
    '3-6 Months': 150,
    '6-12 Months': 270,
    'Just Exploring': 180,
  };
  const offset = days[timeline] ?? 60;
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Promote a record's lifecycle stage. Called by workflows when a site visit
 * completes (→ Prospect) and when a booking is created (→ Customer). Only ever
 * moves forward, so a later enquiry cannot demote an existing customer.
 */
const STAGE_ORDER = ['Lead', 'Prospect', 'Customer', 'Past Customer'];

export async function advanceLifecycle(
  ctx: ServiceContext,
  recordId: string,
  target: 'Lead' | 'Prospect' | 'Customer' | 'Past Customer',
  conn?: Tx,
): Promise<void> {
  const current = await (conn ?? (await import('../../db/pool.js')).db).queryOne<{ lifecycle_stage: string }>(
    `SELECT lifecycle_stage FROM ipy_e_leads WHERE record_id = $1`,
    [recordId],
  );
  if (!current) return;

  const from = STAGE_ORDER.indexOf(current.lifecycle_stage);
  const to = STAGE_ORDER.indexOf(target);
  if (to <= from) return;

  await updateRecord(
    { ...ctx, system: true, source: 'lifecycle' },
    'leads', recordId, { lifecycle_stage: target },
    { conn, skipWorkflow: true },
  );
}

/**
 * Merge duplicate records: keep `primaryId`, fold the others' non-empty values
 * and history into it, then soft-delete the losers.
 */
export async function mergeRecords(
  ctx: ServiceContext,
  moduleName: string,
  primaryId: string,
  duplicateIds: string[],
  fieldChoices: Record<string, string> = {},
): Promise<{ merged: number }> {
  if (duplicateIds.includes(primaryId)) {
    throw new BadRequestError('The primary record cannot also be listed as a duplicate');
  }
  const module = await registry.requireModule(moduleName);

  return transaction(async (tx) => {
    const sysCtx: ServiceContext = { ...ctx, system: true, source: 'merge' };
    const primary = await getRecord(sysCtx, moduleName, primaryId, { conn: tx, withDisplay: false });
    const updates: Record<string, unknown> = {};

    for (const dupId of duplicateIds) {
      const dup = await getRecord(sysCtx, moduleName, dupId, { conn: tx, withDisplay: false });

      for (const field of module.fields) {
        if (!field.isActive || field.isReadonly) continue;
        const chosen = fieldChoices[field.name];
        // Explicit choice wins; otherwise fill only what the primary is missing.
        if (chosen === dupId) {
          updates[field.name] = dup.values[field.name];
        } else if (!chosen) {
          const current = updates[field.name] ?? primary.values[field.name];
          const isBlank = current === null || current === undefined || current === ''
            || (Array.isArray(current) && current.length === 0);
          if (isBlank && dup.values[field.name]) updates[field.name] = dup.values[field.name];
        }
      }

      // Move every child artefact onto the survivor.
      await tx.query(`UPDATE ipy_comment SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_attachment SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_call SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_email_log SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_ai_insight SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_e_activities SET related_to = $1 WHERE related_to = $2`, [primaryId, dupId]);
      // Deals, bookings and payments all reference the party record.
      await tx.query(`UPDATE ipy_e_deals SET contact_id = $1 WHERE contact_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_e_bookings SET contact_id = $1 WHERE contact_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_e_payments SET contact_id = $1 WHERE contact_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_e_site_visits SET lead_id = $1 WHERE lead_id = $2`, [primaryId, dupId]);
      // A conversation is keyed on (channel, handle); if the survivor already has
      // one for that handle, drop the duplicate's rather than violating the unique key.
      await tx.query(
        `UPDATE ipy_conversation c SET record_id = $1
         WHERE c.record_id = $2
           AND NOT EXISTS (SELECT 1 FROM ipy_conversation o WHERE o.channel = c.channel AND o.handle = c.handle AND o.record_id = $1)`,
        [primaryId, dupId],
      );

      await tx.query(
        `UPDATE ipy_record SET is_deleted = true, deleted_at = now(), deleted_by = $2 WHERE id = $1`,
        [dupId, ctx.user.id],
      );
      await tx.query(
        `INSERT INTO ipy_audit (record_id, module_name, user_id, action, changes, source)
         VALUES ($1,$2,$3,'merge',$4,'app')`,
        [primaryId, moduleName, ctx.user.id, JSON.stringify([{ mergedFrom: dupId, label: dup.label }])],
      );
    }

    if (Object.keys(updates).length) {
      await updateRecord(sysCtx, moduleName, primaryId, updates, { conn: tx, skipDuplicateCheck: true });
    }

    return { merged: duplicateIds.length };
  });
}
