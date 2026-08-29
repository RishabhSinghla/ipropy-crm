import { Router } from 'express';
import { z } from 'zod';
import { CAPABILITIES } from '@ipropy/shared';
import { db, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getUser, hashPassword, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { assertCapability, invalidatePermissions } from '../../core/permissions/index.js';
import { registry } from '../../core/metadata/registry.js';
import {
  getSettings, getOneDriveProviderSettings, listIntegrations, getIntegrationSummary, saveIntegration, recordIntegrationResult,
} from '../../core/settings/integrations.js';
import { verifyConnection as verifySmtpConnection } from '../../integrations/email/service.js';
import { syncInboundEmails, testImapConnection } from '../../integrations/email/inbound.js';
import { testAiProvider } from '../../ai/client.js';
import {
  getPropertyShareAdminConfig, savePropertyShareConfig,
} from '../../core/sharing/propertyShare.js';
import { listIntegrationModels } from '../../ai/models.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);
// Administering the CRM is a thing a person does while signed in, not a thing a
// long-lived key in a config file should be able to do on their behalf.
adminRouter.use(blockApiKey);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

adminRouter.get('/users', asyncHandler(async (req, res) => {
  // Every signed-in user needs the directory for owner pickers and @mentions,
  // so this returns a safe projection rather than requiring admin.
  const includeInactive = req.query.includeInactive === 'true';
  const rows = await db.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.phone, u.designation,
            u.is_admin, u.is_active, u.role_id, u.profile_id, u.extension, u.last_login_at,
            u.accepts_leads, u.daily_lead_cap, u.created_at,
            r.name AS role_name, p.name AS profile_name
     FROM ipy_user u
     LEFT JOIN ipy_role r ON r.id = u.role_id
     LEFT JOIN ipy_profile p ON p.id = u.profile_id
     WHERE u.deleted_at IS NULL ${includeInactive ? '' : 'AND u.is_active = true'}
     ORDER BY u.first_name, u.last_name`,
  );
  res.json(rows.rows.map((u) => ({
    id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name,
    fullName: `${u.first_name} ${u.last_name}`.trim(),
    avatarUrl: u.avatar_url, phone: u.phone, designation: u.designation,
    isAdmin: u.is_admin, isActive: u.is_active,
    roleId: u.role_id, roleName: u.role_name,
    profileId: u.profile_id, profileName: u.profile_name,
    extension: u.extension, lastLoginAt: u.last_login_at,
    acceptsLeads: u.accepts_leads, dailyLeadCap: u.daily_lead_cap,
    createdAt: u.created_at,
  })));
}));

const userSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().default(''),
  phone: z.string().optional(),
  designation: z.string().optional(),
  roleId: z.string().uuid().nullable().optional(),
  profileId: z.string().uuid().nullable().optional(),
  reportsTo: z.string().uuid().nullable().optional(),
  isAdmin: z.boolean().default(false),
  extension: z.string().optional(),
  acceptsLeads: z.boolean().default(true),
  dailyLeadCap: z.number().int().positive().nullable().optional(),
});

adminRouter.post('/users', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.users');
  const input = userSchema.parse(req.body);

  const existing = await db.queryOne(`SELECT 1 FROM ipy_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`, [input.email]);
  if (existing) throw new ConflictError('A user with that email already exists');

  const row = await db.queryOne<{ id: string }>(
    // channel_partner_id was dropped from this list and its value was not, so
    // this named fourteen columns and supplied thirteen — every attempt to
    // create a user died on "bind message supplies 13 parameters, but prepared
    // statement requires 14". The column belongs to the channel_partners module,
    // removed in migration 030, and the portal it fed does not exist.
    `INSERT INTO ipy_user
      (email, password_hash, first_name, last_name, phone, designation, role_id,
       profile_id, reports_to, is_admin, extension, accepts_leads, daily_lead_cap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      input.email, await hashPassword(input.password), input.firstName, input.lastName,
      input.phone ?? null, input.designation ?? null, input.roleId ?? null,
      input.profileId ?? null, input.reportsTo ?? null, input.isAdmin,
      input.extension ?? null, input.acceptsLeads, input.dailyLeadCap ?? null,
    ],
  );
  invalidatePermissions();
  res.status(201).json({ id: row?.id });
}));

adminRouter.patch('/users/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.users');
  const input = userSchema.partial().omit({ password: true }).extend({
    isActive: z.boolean().optional(),
  }).parse(req.body);

  const map: Record<string, string> = {
    email: 'email', firstName: 'first_name', lastName: 'last_name', phone: 'phone',
    designation: 'designation', roleId: 'role_id', profileId: 'profile_id',
    reportsTo: 'reports_to', isAdmin: 'is_admin', isActive: 'is_active',
    extension: 'extension', acceptsLeads: 'accepts_leads', dailyLeadCap: 'daily_lead_cap',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [k, v] of Object.entries(input)) {
    const col = map[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_user SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  invalidatePermissions();
  res.json({ ok: true });
}));

adminRouter.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.users');
  const { password } = z.object({ password: z.string().min(8) }).parse(req.body);
  await db.query(
    `UPDATE ipy_user SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
    [req.params.id, await hashPassword(password)],
  );
  // Existing sessions must not survive an admin-forced reset.
  await db.query(`UPDATE ipy_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [req.params.id]);
  res.json({ ok: true });
}));

adminRouter.delete('/users/:id', asyncHandler(async (req, res) => {
  const actor = getUser(req);
  await assertCapability(actor, 'admin.users');
  if (req.params.id === actor.id) throw new BadRequestError('You cannot deactivate your own account');

  const open = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_record WHERE owner_id = $1 AND is_deleted = false`,
    [req.params.id],
  );
  const transferTo = typeof req.query.transferTo === 'string' ? req.query.transferTo : null;
  if ((open?.count ?? 0) > 0 && !transferTo) {
    throw new ConflictError(
      `This user still owns ${open?.count} records. Pass ?transferTo=<userId> to reassign them.`,
      { openRecords: open?.count },
    );
  }
  await transaction(async (tx) => {
    if (transferTo) {
      await tx.query(`UPDATE ipy_record SET owner_id = $2 WHERE owner_id = $1 AND is_deleted = false`, [req.params.id, transferTo]);
    }
    await tx.query(`UPDATE ipy_user SET is_active = false, deleted_at = now() WHERE id = $1`, [req.params.id]);
    await tx.query(`UPDATE ipy_session SET revoked_at = now() WHERE user_id = $1`, [req.params.id]);
  });
  invalidatePermissions();
  res.json({ ok: true, transferred: transferTo ? open?.count ?? 0 : 0 });
}));

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

adminRouter.get('/roles', asyncHandler(async (_req, res) => {
  const rows = await db.query<{ id: string; name: string; parent_id: string | null; depth: number; description: string | null; user_count: number }>(
    `SELECT r.id, r.name, r.parent_id, r.depth, r.description,
            (SELECT COUNT(*)::int FROM ipy_user u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS user_count
     FROM ipy_role r ORDER BY r.depth, r.sequence, r.name`,
  );

  // Nest into a tree so the UI can render the hierarchy directly.
  const byId = new Map(rows.rows.map((r) => [r.id, { ...r, children: [] as unknown[] }]));
  const roots: unknown[] = [];
  for (const role of byId.values()) {
    if (role.parent_id && byId.has(role.parent_id)) {
      (byId.get(role.parent_id)!.children as unknown[]).push(role);
    } else {
      roots.push(role);
    }
  }
  res.json({ tree: roots, flat: rows.rows });
}));

adminRouter.post('/roles', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.roles');
  const { name, parentId, description } = z.object({
    name: z.string().min(1),
    parentId: z.string().uuid().nullable().optional(),
    description: z.string().optional(),
  }).parse(req.body);

  const parent = parentId
    ? await db.queryOne<{ depth: number; path: string[] }>(`SELECT depth, path FROM ipy_role WHERE id = $1`, [parentId])
    : null;

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_role (name, parent_id, depth, path, description) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name, parentId ?? null, (parent?.depth ?? -1) + 1, [...(parent?.path ?? []), ...(parentId ? [parentId] : [])], description ?? null],
  );
  invalidatePermissions();
  res.status(201).json({ id: row?.id });
}));

adminRouter.patch('/roles/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.roles');
  const { name, parentId, description } = z.object({
    name: z.string().min(1).optional(),
    parentId: z.string().uuid().nullable().optional(),
    description: z.string().optional(),
  }).parse(req.body);

  await transaction(async (tx) => {
    if (parentId !== undefined) {
      // Re-parenting must rewrite the whole subtree's depth and path or the
      // hierarchy-based data scoping silently breaks.
      const role = await tx.queryOne<{ path: string[]; depth: number }>(`SELECT path, depth FROM ipy_role WHERE id = $1`, [req.params.id]);
      if (!role) throw new NotFoundError('Role not found');
      if (parentId === req.params.id) throw new BadRequestError('A role cannot report to itself');

      const parent = parentId
        ? await tx.queryOne<{ depth: number; path: string[] }>(`SELECT depth, path FROM ipy_role WHERE id = $1`, [parentId])
        : null;
      if (parent?.path?.includes(req.params.id)) {
        throw new BadRequestError('That would create a circular reporting line');
      }

      const newPath = [...(parent?.path ?? []), ...(parentId ? [parentId] : [])];
      const newDepth = (parent?.depth ?? -1) + 1;
      const depthShift = newDepth - role.depth;

      await tx.query(`UPDATE ipy_role SET parent_id = $2, path = $3, depth = $4 WHERE id = $1`, [
        req.params.id, parentId ?? null, newPath, newDepth,
      ]);
      await tx.query(
        `UPDATE ipy_role
         SET depth = depth + $2,
             path = $3::uuid[] || path[array_position(path, $1::uuid):array_length(path,1)]
         WHERE $1 = ANY(path)`,
        [req.params.id, depthShift, newPath],
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
    if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
    if (sets.length) await tx.query(`UPDATE ipy_role SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  });

  invalidatePermissions();
  res.json({ ok: true });
}));

adminRouter.delete('/roles/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.roles');
  const users = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_user WHERE role_id = $1 AND deleted_at IS NULL`, [req.params.id],
  );
  if ((users?.count ?? 0) > 0) throw new ConflictError(`${users?.count} users still hold this role. Move them first.`);
  await db.query(`DELETE FROM ipy_role WHERE id = $1`, [req.params.id]);
  invalidatePermissions();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Profiles (module + field permissions)
// ---------------------------------------------------------------------------

adminRouter.get('/profiles', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT p.id, p.name, p.description, p.is_system, p.capabilities,
            (SELECT COUNT(*)::int FROM ipy_user u WHERE u.profile_id = p.id AND u.deleted_at IS NULL) AS user_count
     FROM ipy_profile p ORDER BY p.is_system DESC, p.name`,
  );
  res.json(rows.rows);
}));

adminRouter.get('/profiles/:id', asyncHandler(async (req, res) => {
  const profile = await db.queryOne(`SELECT * FROM ipy_profile WHERE id = $1`, [req.params.id]);
  if (!profile) throw new NotFoundError('Profile not found');

  const [modulePerms, fieldPerms] = await Promise.all([
    db.query(
      `SELECT m.name AS module, p.can_view, p.can_create, p.can_edit, p.can_delete, p.can_export, p.can_import
       FROM ipy_profile_module_perm p JOIN ipy_module m ON m.id = p.module_id
       WHERE p.profile_id = $1`,
      [req.params.id],
    ),
    db.query(
      `SELECT m.name AS module, f.name AS field, f.label, p.permission
       FROM ipy_profile_field_perm p
       JOIN ipy_field f ON f.id = p.field_id
       JOIN ipy_module m ON m.id = f.module_id
       WHERE p.profile_id = $1`,
      [req.params.id],
    ),
  ]);

  res.json({
    ...profile,
    modulePermissions: Object.fromEntries(modulePerms.rows.map((r) => [
      (r as { module: string }).module,
      {
        view: (r as { can_view: boolean }).can_view,
        create: (r as { can_create: boolean }).can_create,
        edit: (r as { can_edit: boolean }).can_edit,
        delete: (r as { can_delete: boolean }).can_delete,
        export: (r as { can_export: boolean }).can_export,
        import: (r as { can_import: boolean }).can_import,
      },
    ])),
    fieldPermissions: fieldPerms.rows,
    availableCapabilities: CAPABILITIES,
  });
}));

adminRouter.post('/profiles', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.profiles');
  const { name, description, cloneFrom } = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    cloneFrom: z.string().uuid().optional(),
  }).parse(req.body);

  const id = await transaction(async (tx) => {
    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_profile (name, description, capabilities)
       VALUES ($1,$2,COALESCE((SELECT capabilities FROM ipy_profile WHERE id = $3),'[]'::jsonb))
       RETURNING id`,
      [name, description ?? null, cloneFrom ?? null],
    );
    if (cloneFrom) {
      await tx.query(
        `INSERT INTO ipy_profile_module_perm (profile_id, module_id, can_view, can_create, can_edit, can_delete, can_export, can_import)
         SELECT $1, module_id, can_view, can_create, can_edit, can_delete, can_export, can_import
         FROM ipy_profile_module_perm WHERE profile_id = $2`,
        [row!.id, cloneFrom],
      );
      await tx.query(
        `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
         SELECT $1, field_id, permission FROM ipy_profile_field_perm WHERE profile_id = $2`,
        [row!.id, cloneFrom],
      );
    }
    return row!.id;
  });
  invalidatePermissions();
  res.status(201).json({ id });
}));

adminRouter.put('/profiles/:id/permissions', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.profiles');
  const { modulePermissions, fieldPermissions, capabilities } = z.object({
    modulePermissions: z.record(z.object({
      view: z.boolean(), create: z.boolean(), edit: z.boolean(),
      delete: z.boolean(), export: z.boolean(), import: z.boolean(),
    })).optional(),
    fieldPermissions: z.array(z.object({
      module: z.string(), field: z.string(),
      permission: z.enum(['hidden', 'readonly', 'editable']),
    })).optional(),
    capabilities: z.array(z.string()).optional(),
  }).parse(req.body);

  await transaction(async (tx) => {
    if (capabilities) {
      await tx.query(`UPDATE ipy_profile SET capabilities = $2, updated_at = now() WHERE id = $1`, [
        req.params.id, JSON.stringify(capabilities),
      ]);
    }
    if (modulePermissions) {
      for (const [moduleName, p] of Object.entries(modulePermissions)) {
        const mod = await tx.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [moduleName]);
        if (!mod) continue;
        await tx.query(
          `INSERT INTO ipy_profile_module_perm (profile_id, module_id, can_view, can_create, can_edit, can_delete, can_export, can_import)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (profile_id, module_id) DO UPDATE SET
             can_view = EXCLUDED.can_view, can_create = EXCLUDED.can_create,
             can_edit = EXCLUDED.can_edit, can_delete = EXCLUDED.can_delete,
             can_export = EXCLUDED.can_export, can_import = EXCLUDED.can_import`,
          [req.params.id, mod.id, p.view, p.create, p.edit, p.delete, p.export, p.import],
        );
      }
    }
    if (fieldPermissions) {
      for (const fp of fieldPermissions) {
        const fld = await tx.queryOne<{ id: string }>(
          `SELECT f.id FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id WHERE m.name = $1 AND f.name = $2`,
          [fp.module, fp.field],
        );
        if (!fld) continue;
        await tx.query(
          `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission) VALUES ($1,$2,$3)
           ON CONFLICT (profile_id, field_id) DO UPDATE SET permission = EXCLUDED.permission`,
          [req.params.id, fld.id, fp.permission],
        );
      }
    }
  });
  invalidatePermissions();
  res.json({ ok: true });
}));

adminRouter.delete('/profiles/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.profiles');
  const profile = await db.queryOne<{ is_system: boolean }>(`SELECT is_system FROM ipy_profile WHERE id = $1`, [req.params.id]);
  if (profile?.is_system) throw new BadRequestError('Built-in profiles cannot be deleted');
  const users = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_user WHERE profile_id = $1 AND deleted_at IS NULL`, [req.params.id],
  );
  if ((users?.count ?? 0) > 0) throw new ConflictError(`${users?.count} users are on this profile. Move them first.`);
  await db.query(`DELETE FROM ipy_profile WHERE id = $1`, [req.params.id]);
  invalidatePermissions();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

adminRouter.get('/groups', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT g.id, g.name, g.description, g.kind,
            COALESCE(json_agg(json_build_object('type', gm.member_type, 'id', gm.member_id))
              FILTER (WHERE gm.member_id IS NOT NULL), '[]') AS members
     FROM ipy_group g LEFT JOIN ipy_group_member gm ON gm.group_id = g.id
     GROUP BY g.id ORDER BY g.name`,
  );
  res.json(rows.rows);
}));

adminRouter.post('/groups', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.users');
  const { name, description, members } = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    members: z.array(z.object({
      type: z.enum(['user', 'role', 'role_subordinates', 'group']),
      id: z.string().uuid(),
    })).default([]),
  }).parse(req.body);

  const id = await transaction(async (tx) => {
    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_group (name, description) VALUES ($1,$2) RETURNING id`,
      [name, description ?? null],
    );
    for (const m of members) {
      await tx.query(`INSERT INTO ipy_group_member (group_id, member_type, member_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
        row!.id, m.type, m.id,
      ]);
    }
    return row!.id;
  });
  invalidatePermissions();
  res.status(201).json({ id });
}));

adminRouter.put('/groups/:id/members', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.users');
  const { members } = z.object({
    members: z.array(z.object({
      type: z.enum(['user', 'role', 'role_subordinates', 'group']),
      id: z.string().uuid(),
    })),
  }).parse(req.body);

  await transaction(async (tx) => {
    await tx.query(`DELETE FROM ipy_group_member WHERE group_id = $1`, [req.params.id]);
    for (const m of members) {
      await tx.query(`INSERT INTO ipy_group_member (group_id, member_type, member_id) VALUES ($1,$2,$3)`, [
        req.params.id, m.type, m.id,
      ]);
    }
  });
  invalidatePermissions();
  res.json({ ok: true });
}));

adminRouter.delete('/groups/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.users');
  await db.query(`DELETE FROM ipy_group WHERE id = $1`, [req.params.id]);
  invalidatePermissions();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

adminRouter.get('/sharing', asyncHandler(async (_req, res) => {
  const [defaults, rules] = await Promise.all([
    db.query(
      `SELECT m.name AS module, m.label, COALESCE(s.access,'private') AS access
       FROM ipy_module m LEFT JOIN ipy_module_sharing s ON s.module_id = m.id
       WHERE m.is_entity AND m.is_active ORDER BY m.sequence`,
    ),
    db.query(
      `SELECT sr.id, m.name AS module, sr.name, sr.from_type, sr.from_id,
              sr.to_type, sr.to_id, sr.access, sr.is_active
       FROM ipy_sharing_rule sr JOIN ipy_module m ON m.id = sr.module_id
       ORDER BY m.sequence, sr.name`,
    ),
  ]);
  res.json({ defaults: defaults.rows, rules: rules.rows });
}));

adminRouter.put('/sharing/defaults', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.sharing');
  const { defaults } = z.object({
    defaults: z.record(z.enum(['private', 'public_read', 'public_read_write', 'public_read_write_delete'])),
  }).parse(req.body);

  await transaction(async (tx) => {
    for (const [moduleName, access] of Object.entries(defaults)) {
      const mod = await tx.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [moduleName]);
      if (!mod) continue;
      await tx.query(
        `INSERT INTO ipy_module_sharing (module_id, access) VALUES ($1,$2)
         ON CONFLICT (module_id) DO UPDATE SET access = EXCLUDED.access`,
        [mod.id, access],
      );
    }
  });
  invalidatePermissions();
  res.json({ ok: true });
}));

adminRouter.post('/sharing/rules', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.sharing');
  const input = z.object({
    module: z.string(),
    name: z.string().min(1),
    fromType: z.enum(['role', 'role_and_subordinates', 'group', 'user', 'all']),
    fromId: z.string().uuid().nullable(),
    toType: z.enum(['role', 'role_and_subordinates', 'group', 'user', 'all']),
    toId: z.string().uuid().nullable(),
    access: z.enum(['read', 'read_write']).default('read'),
  }).parse(req.body);

  const mod = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [input.module]);
  if (!mod) throw new NotFoundError(`Unknown module '${input.module}'`);

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_sharing_rule (module_id, name, from_type, from_id, to_type, to_id, access)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [mod.id, input.name, input.fromType, input.fromId, input.toType, input.toId, input.access],
  );
  invalidatePermissions();
  res.status(201).json({ id: row?.id });
}));

adminRouter.delete('/sharing/rules/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.sharing');
  await db.query(`DELETE FROM ipy_sharing_rule WHERE id = $1`, [req.params.id]);
  invalidatePermissions();
  res.json({ ok: true });
}));

/**
 * What leaves the CRM through a buyer-facing property link.
 *
 * This is deliberately its own endpoint instead of exposing the raw setting:
 * callers receive only fields the server considers safe to make public, with
 * current admin-renamed labels from metadata.
 */
adminRouter.get('/sharing/property-link', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.sharing');
  res.json(await getPropertyShareAdminConfig());
}));

adminRouter.put('/sharing/property-link', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.sharing');
  const input = z.object({
    visibleFields: z.array(z.string()).max(200),
    showPhotos: z.boolean(),
  }).parse(req.body);
  await savePropertyShareConfig(input, user.id);
  res.json(await getPropertyShareAdminConfig());
}));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

adminRouter.get('/settings', asyncHandler(async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : null;
  const rows = await db.query<{ key: string; value: unknown; category: string; label: string | null; description: string | null; is_secret: boolean }>(
    `SELECT key, value, category, label, description, is_secret FROM ipy_setting
     ${category ? 'WHERE category = $1' : ''} ORDER BY category, key`,
    category ? [category] : [],
  );
  const isAdmin = getUser(req).isAdmin;
  res.json(rows.rows.map((r) => ({
    ...r,
    value: r.is_secret && !isAdmin ? '••••••••' : r.value,
  })));
}));

/**
 * Does this model actually answer?
 *
 * A real call, not a `/models` listing. A model id can be listed and still be
 * retired, out of quota, wrong for the job, or unable to see a picture — and
 * every one of those shows up here as the same failure the CRM would hit on a
 * property. Which is the whole point of a test button.
 *
 * Kept deliberately tiny: one word of text, one 1x1 pixel for the vision jobs,
 * eight characters of speech. A test that costs money is a test nobody presses.
 */
adminRouter.post('/ai-models/test', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.access');
  const { job, model } = z.object({
    job: z.string().min(1).max(40),
    model: z.string().min(2).max(160),
  }).parse(req.body);

  const { testMediaModel } = await import('../../ai/mediaTest.js');
  res.json(await testMediaModel(job, model.trim()));
}));

/**
 * Where everybody is, newest fix each.
 *
 * Deliberately not behind `admin.access`. Visibility follows the role hierarchy
 * exactly as records do — an admin sees everybody, a manager sees their own
 * people, everybody else sees themselves — because a second answer to "who may
 * look" is how one part of a CRM ends up with its own rules.
 */
adminRouter.get('/team/locations', asyncHandler(async (req, res) => {
  const { teamPositions, locationSettings } = await import('../../core/locations/index.js');
  const [positions, settings] = await Promise.all([
    teamPositions(getUser(req)),
    locationSettings(),
  ]);
  res.json({ positions, settings });
}));

/** One person's path, for drawing a line rather than a dot. */
adminRouter.get('/team/locations/:userId', asyncHandler(async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 12));
  const { trail } = await import('../../core/locations/index.js');
  res.json({ trail: await trail(getUser(req), req.params.userId, hours) });
}));

adminRouter.put('/settings', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.access');
  const { settings } = z.object({ settings: z.record(z.unknown()) }).parse(req.body);

  await transaction(async (tx) => {
    for (const [key, value] of Object.entries(settings)) {
      await tx.query(
        `INSERT INTO ipy_setting (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), user.id],
      );
    }
  });
  // Scoring caches its thresholds because it runs on every record change. An
  // edit that only takes effect after a restart is the "it doesn't persist"
  // complaint in a different costume.
  const { invalidateScoring, invalidatePublicStatuses } = await import('../../core/settings/scoring.js');
  invalidateScoring();
  invalidatePublicStatuses();
  // Same contract for everything else that caches a setting. A model swapped in
  // a text box has to be live on the next job, not after the next deploy —
  // otherwise "it does not persist" is exactly what it looks like.
  const { invalidateAiModels } = await import('../../core/settings/aiModels.js');
  const { invalidateHouseStyle } = await import('../../core/settings/houseStyle.js');
  const { invalidateAiFeatures } = await import('../../core/settings/aiFeatures.js');
  const { invalidateLocationSettings } = await import('../../core/locations/index.js');
  const { invalidateUiSettings } = await import('../../core/settings/ui.js');
  const { invalidateStageMap } = await import('../../core/entity/lifecycleFromStatus.js');
  const { invalidatePhoneMasking } = await import('../../core/permissions/maskPhones.js');
  const { invalidateGreeting } = await import('../../integrations/whatsapp/greetNewLead.js');
  invalidatePhoneMasking();
  invalidateGreeting();
  invalidateLocationSettings();
  invalidateUiSettings();
  invalidateStageMap();
  invalidateAiModels();
  invalidateHouseStyle();
  invalidateAiFeatures();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Audit log (org-wide)
// ---------------------------------------------------------------------------

adminRouter.get('/audit', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.audit');
  const { module, userId, action, limit, offset } = z.object({
    module: z.string().optional(),
    userId: z.string().uuid().optional(),
    action: z.string().optional(),
    limit: z.coerce.number().int().max(500).default(100),
    offset: z.coerce.number().int().default(0),
  }).parse(req.query);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (module) { params.push(module); clauses.push(`a.module_name = $${params.length}`); }
  if (userId) { params.push(userId); clauses.push(`a.user_id = $${params.length}`); }
  if (action) { params.push(action); clauses.push(`a.action = $${params.length}`); }
  params.push(limit, offset);

  const rows = await db.query(
    `SELECT a.id, a.record_id, a.module_name, a.action, a.changes, a.source, a.ip_address, a.created_at,
            trim(u.first_name || ' ' || u.last_name) AS user_name, r.label AS record_label
     FROM ipy_audit a
     LEFT JOIN ipy_user u ON u.id = a.user_id
     LEFT JOIN ipy_record r ON r.id = a.record_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// System health / diagnostics
// ---------------------------------------------------------------------------

/**
 * Whether this deployment is actually ready for a team.
 *
 * Separate from /health, which answers "is the server up". This answers "is the
 * configuration around it finished", which is a different question and the one
 * that decides whether handing the address to five people is safe.
 */
adminRouter.get('/readiness', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.access');
  const { readinessReport } = await import('../../core/readiness.js');
  res.json(await readinessReport());
}));

adminRouter.get('/health', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.access');
  const [counts, queue, integrations, aiUsage] = await Promise.all([
    db.query<{ module_name: string; count: number }>(
      `SELECT module_name, COUNT(*)::int AS count FROM ipy_record WHERE is_deleted = false GROUP BY 1 ORDER BY 2 DESC`,
    ),
    db.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM ipy_task_queue GROUP BY 1`,
    ),
    db.query(`SELECT provider, kind, label, is_active, status, last_sync_at, last_error FROM ipy_integration ORDER BY kind, label`),
    db.queryOne<{ calls: number; input: number; output: number }>(
      `SELECT COUNT(*)::int AS calls, COALESCE(SUM(input_tokens),0)::int AS input, COALESCE(SUM(output_tokens),0)::int AS output
       FROM ipy_ai_log WHERE created_at > now() - interval '30 days'`,
    ),
  ]);

  const modules = await registry.getModules();
  res.json({
    recordCounts: counts.rows,
    taskQueue: Object.fromEntries(queue.rows.map((q) => [q.status, q.count])),
    integrations: integrations.rows,
    aiUsage30d: aiUsage,
    metadata: {
      modules: modules.length,
      fields: modules.reduce((n, m) => n + m.fields.length, 0),
      customModules: modules.filter((m) => m.isCustom).length,
      customFields: modules.reduce((n, m) => n + m.fields.filter((f) => f.isCustom).length, 0),
    },
    uptimeSeconds: Math.round(process.uptime()),
  });
}));

// ---------------------------------------------------------------------------
// Integration settings — configure providers from the UI instead of .env
// ---------------------------------------------------------------------------

adminRouter.get('/integrations', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  res.json(await listIntegrations());
}));

/** Live provider catalogue for the model pickers; secrets never leave here. */
adminRouter.get('/integrations/:provider/models', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const existing = await getIntegrationSummary(req.params.provider);
  if (!existing) throw new NotFoundError(`Unknown integration provider '${req.params.provider}'`);
  const catalogue = await listIntegrationModels(req.params.provider);
  if (!catalogue) throw new BadRequestError('This integration does not expose AI models');
  res.json(catalogue);
}));

adminRouter.get('/integrations/:provider', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const summary = await getIntegrationSummary(req.params.provider);
  if (!summary) throw new NotFoundError(`Unknown integration provider '${req.params.provider}'`);
  res.json(summary);
}));

adminRouter.put('/integrations/:provider', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const input = z.object({
    config: z.record(z.string()).optional(),
    credentials: z.record(z.string()).optional(),
    isActive: z.boolean().optional(),
  }).parse(req.body);

  const existing = await getIntegrationSummary(req.params.provider);
  if (!existing) throw new NotFoundError(`Unknown integration provider '${req.params.provider}'`);

  await saveIntegration(req.params.provider, input);
  res.json(await getIntegrationSummary(req.params.provider));
}));

/** Lightweight, read-only connectivity check per provider. Never throws. */
async function testIntegration(provider: string): Promise<{ ok: boolean; message: string }> {
  const s = getSettings();
  try {
    switch (provider) {
      case 'meta_whatsapp': {
        const { phoneNumberId, accessToken, apiVersion } = s.whatsapp;
        if (!phoneNumberId || !accessToken) return { ok: false, message: 'Phone number ID and access token are required.' };
        const r = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=display_phone_number`, {
          headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000),
        });
        const body = await r.json().catch(() => ({})) as { display_phone_number?: string; error?: { message?: string } };
        if (!r.ok) return { ok: false, message: body.error?.message ?? `Meta returned HTTP ${r.status}` };
        return { ok: true, message: `Connected — ${body.display_phone_number ?? 'number verified'}.` };
      }
      case 'twilio': {
        const { accountSid, authToken } = s.telephony.twilio;
        if (!accountSid || !authToken) return { ok: false, message: 'Account SID and auth token are required.' };
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
          headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
          signal: AbortSignal.timeout(10_000),
        });
        const body = await r.json().catch(() => ({})) as { friendly_name?: string; message?: string };
        if (!r.ok) return { ok: false, message: body.message ?? `Twilio returned HTTP ${r.status}` };
        return { ok: true, message: `Connected — ${body.friendly_name ?? 'account verified'}.` };
      }
      case 'exotel': {
        const { sid, apiKey, apiToken, subdomain } = s.telephony.exotel;
        if (!sid || !apiKey || !apiToken) return { ok: false, message: 'SID, API key and API token are required.' };
        const r = await fetch(`https://${apiKey}:${apiToken}@${subdomain}/v1/Accounts/${sid}/Calls.json?PageSize=1`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { RestException?: { Message?: string } };
          return { ok: false, message: body.RestException?.Message ?? `Exotel returned HTTP ${r.status}` };
        }
        return { ok: true, message: 'Connected — credentials accepted.' };
      }
      case 'smtp': {
        if (!s.email.host) return { ok: false, message: 'SMTP host is required.' };
        const result = await verifySmtpConnection();
        return result.ok ? { ok: true, message: 'Connected — SMTP server accepted the credentials.' } : { ok: false, message: result.error ?? 'Connection failed.' };
      }
      case 'imap': {
        const result = await testImapConnection();
        if (!result.ok) return { ok: false, message: result.error ?? 'Connection failed.' };
        return { ok: true, message: `Connected — ${result.unseen ?? 0} unseen messages waiting.` };
      }
      case 'anthropic':
        return testAiProvider('anthropic');
      case 'ai_gemini':
        return testAiProvider('gemini');
      case 'ai_groq':
        return testAiProvider('groq');
      case 'ai_openrouter':
        return testAiProvider('openrouter');
      case 'ai_opencode':
        return testAiProvider('opencode');
      case 'ai_openai':
        return testAiProvider('openai');
      case 'ai_ollama':
        return testAiProvider('ollama');
      case 'stt': {
        const catalogue = await listIntegrationModels('stt');
        return catalogue?.live
          ? { ok: true, message: `Connected — ${catalogue.models.length} transcription model${catalogue.models.length === 1 ? '' : 's'} available.` }
          : { ok: false, message: catalogue?.warning ?? 'Could not verify the speech provider.' };
      }
      case 'onedrive': {
        const { testOneDriveConnection } = await import('../../core/storage/onedrive.js');
        const result = await testOneDriveConnection(getOneDriveProviderSettings());
        return { ok: true, message: `Connected — ${result.name}. The iPropy root folder is writable.` };
      }
      case 'facebook_leads':
        if (!s.leadSources.facebook.pageAccessToken) return { ok: false, message: 'A page access token is required.' };
        return { ok: true, message: 'Page access token is set. Full verification happens on the next inbound lead.' };
      default:
        return { ok: false, message: 'This provider does not support a connectivity test — save the settings and check the webhook logs instead.' };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed.' };
  }
}

adminRouter.post('/integrations/:provider/test', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const result = await testIntegration(req.params.provider);
  await recordIntegrationResult(req.params.provider, result.ok, result.ok ? undefined : result.message);
  res.json(result);
}));

/** Pull the configured mailbox now instead of waiting for the scheduler. */
adminRouter.post('/integrations/imap/sync', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const result = await syncInboundEmails({ max: Number(req.query.max) || 25 });
  const ok = result.errors.length === 0;
  await recordIntegrationResult('imap', ok, ok ? undefined : result.errors[0]);
  res.json(result);
}));
