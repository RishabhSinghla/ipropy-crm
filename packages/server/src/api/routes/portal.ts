/**
 * Channel Partner portal API.
 *
 * A portal user is an ipy_user whose channel_partner_id points at a
 * channel_partners record. Every endpoint is scoped to that partner id taken
 * from the authenticated user — never from the request body — so one partner
 * cannot read or write another's data even with a crafted payload.
 *
 * Reads go through recordService with a system context (the portal profile
 * may not have module access at all) plus a forced channel_partner_id filter,
 * then get stripped of fields the portal profile cannot see — field hiding
 * must hold on data, not just metadata.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ForbiddenError } from '../../utils/errors.js';
import type { AuthUser } from '@ipropy/shared';
import type { ServiceContext } from '../../core/entity/recordService.js';
import { recordService } from '../../core/entity/recordService.js';
import { getFieldPermissions } from '../../core/permissions/index.js';
import { captureLead, type NormalizedLead } from '../../integrations/leadsources/capture.js';
import { registry } from '../../core/metadata/registry.js';

export const portalRouter = Router();
portalRouter.use(requireAuth);

/** The partner record every request in this router is scoped to. */
async function requirePartner(user: AuthUser): Promise<{ id: string; values: Record<string, unknown> }> {
  if (!user.channelPartnerId) {
    throw new ForbiddenError('Your account is not linked to a channel partner');
  }
  const envelope = await recordService.getRecord(
    { user, subordinateIds: [], groupIds: [], system: true },
    'channel_partners',
    user.channelPartnerId,
    { withDisplay: false },
  );
  if (envelope.values.portal_access !== true) {
    throw new ForbiddenError('Partner portal access is disabled for your account');
  }
  return { id: user.channelPartnerId, values: envelope.values };
}

function systemCtx(user: AuthUser, source: string): ServiceContext {
  return { user, subordinateIds: [], groupIds: [], system: true, source };
}

/** Field hiding is enforced on data, not just metadata. */
async function stripHidden(
  user: AuthUser,
  moduleName: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const perms = await getFieldPermissions(user, moduleName);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (perms.get(key) !== 'hidden') out[key] = value;
  }
  return out;
}

function parsePage(q: Record<string, unknown>): { page: number; pageSize: number } {
  return {
    page: Math.max(1, Number(q.page) || 1),
    pageSize: Math.min(100, Math.max(1, Number(q.pageSize) || 25)),
  };
}

// ---------------------------------------------------------------------------
// GET /overview — partner profile + live performance stats
// ---------------------------------------------------------------------------

portalRouter.get('/overview', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const partner = await requirePartner(user);

  const rows = await db.query<{
    leads: string; site_visits: string; bookings: string;
    agreement_value: string; commission: string;
  }>(
    `SELECT
       (SELECT count(*) FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
         WHERE l.channel_partner_id = $1 AND r.is_deleted = false)::text AS leads,
       (SELECT count(*) FROM ipy_e_site_visits sv JOIN ipy_record r ON r.id = sv.record_id
         WHERE sv.channel_partner_id = $1 AND r.is_deleted = false)::text AS site_visits,
       (SELECT count(*) FROM ipy_e_bookings b JOIN ipy_record r ON r.id = b.record_id
         WHERE b.channel_partner_id = $1 AND r.is_deleted = false)::text AS bookings,
       (SELECT coalesce(sum(b.agreement_value), 0) FROM ipy_e_bookings b JOIN ipy_record r ON r.id = b.record_id
         WHERE b.channel_partner_id = $1 AND r.is_deleted = false)::text AS agreement_value,
       (SELECT coalesce(sum(b.broker_commission), 0) FROM ipy_e_bookings b JOIN ipy_record r ON r.id = b.record_id
         WHERE b.channel_partner_id = $1 AND r.is_deleted = false)::text AS commission`,
    [partner.id],
  );
  const stats = rows.rows[0] ?? { leads: '0', site_visits: '0', bookings: '0', agreement_value: '0', commission: '0' };

  res.json({
    partner: await stripHidden(user, 'channel_partners', partner.values),
    stats: {
      leads: Number(stats.leads),
      siteVisits: Number(stats.site_visits),
      bookings: Number(stats.bookings),
      agreementValue: Number(stats.agreement_value),
      commission: Number(stats.commission),
    },
  });
}));

// ---------------------------------------------------------------------------
// GET /leads — the partner's own leads
// ---------------------------------------------------------------------------

portalRouter.get('/leads', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const partner = await requirePartner(user);
  const { page, pageSize } = parsePage(req.query as Record<string, unknown>);

  const result = await recordService.listRecords(
    systemCtx(user, 'portal'),
    'leads',
    {
      page,
      pageSize,
      sortBy: typeof req.query.sortBy === 'string' ? req.query.sortBy : 'created_at',
      sortDir: 'desc',
      filter: {
        logic: 'AND',
        conditions: [{ field: 'channel_partner_id', operator: 'equals', value: partner.id }],
      },
    },
  );

  const rows = [];
  for (const env of result.rows) {
    rows.push({ id: env.id, label: env.label, values: await stripHidden(user, 'leads', env.values) });
  }
  res.json({ rows, total: result.total, page, pageSize });
}));

// ---------------------------------------------------------------------------
// GET /bookings — the partner's bookings with financials
// ---------------------------------------------------------------------------

portalRouter.get('/bookings', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const partner = await requirePartner(user);
  const { page, pageSize } = parsePage(req.query as Record<string, unknown>);

  const result = await recordService.listRecords(
    systemCtx(user, 'portal'),
    'bookings',
    {
      page,
      pageSize,
      sortBy: typeof req.query.sortBy === 'string' ? req.query.sortBy : 'created_at',
      sortDir: 'desc',
      filter: {
        logic: 'AND',
        conditions: [{ field: 'channel_partner_id', operator: 'equals', value: partner.id }],
      },
    },
  );

  const rows = [];
  for (const env of result.rows) {
    rows.push({ id: env.id, label: env.label, values: await stripHidden(user, 'bookings', env.values) });
  }
  res.json({ rows, total: result.total, page, pageSize });
}));

// ---------------------------------------------------------------------------
// POST /leads — submit a new enquiry, attributed to this partner
// ---------------------------------------------------------------------------

const submitSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().max(120).optional().default(''),
  mobile: z.string().trim().min(7).max(20).optional(),
  email: z.string().email().optional().or(z.literal('')),
  message: z.string().trim().max(5000).optional().default(''),
  projectId: z.string().uuid().optional().nullable().default(null),
  configuration: z.array(z.string()).optional().default([]),
  budgetMin: z.number().nonnegative().optional().nullable().default(null),
  budgetMax: z.number().nonnegative().optional().nullable().default(null),
}).refine((v) => v.mobile || v.email, { message: 'A mobile number or email is required' });

portalRouter.post('/leads', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const partner = await requirePartner(user);

  const parsed = submitSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid submission');
  }
  const b = parsed.data;

  const normalized: NormalizedLead = {
    firstName: b.firstName,
    lastName: b.lastName,
    mobile: b.mobile || undefined,
    email: b.email || undefined,
    source: 'Channel Partner',
    message: b.message || undefined,
    projectId: b.projectId ?? undefined,
    configuration: b.configuration,
    budgetMin: b.budgetMin ?? undefined,
    budgetMax: b.budgetMax ?? undefined,
    // The partner id is always taken from the session, never from the payload.
    extra: { channel_partner_id: partner.id },
  };

  const result = await captureLead('Channel Partner', req.body, normalized, { createdBy: user });
  res.status(result.status === 'created' ? 201 : 200).json(result);
}));

// ---------------------------------------------------------------------------
// GET /schema — field vocabulary for the submit form (rendered client-side)
// ---------------------------------------------------------------------------

portalRouter.get('/schema', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await requirePartner(user);
  const module = await registry.requireModule('leads');
  const wanted = new Set(['interested_project_id', 'configuration', 'budget_min', 'budget_max']);
  const fields = module.fields
    .filter((f) => wanted.has(f.name) && f.isActive)
    .map((f) => ({ name: f.name, label: f.label, uitype: f.uitype, picklist: f.config?.picklist ?? null }));
  res.json({ fields });
}));
