/**
 * Permission engine.
 *
 * Four layers, evaluated in order, mirroring Vtiger's model:
 *   1. Profile  → can this user touch the module at all? which fields?
 *   2. Org default sharing → private / public read / public read-write
 *   3. Sharing rules → role/group-to-role/group grants
 *   4. Record-level → ownership, role hierarchy, explicit shares
 *
 * `recordScopeSql()` produces the WHERE fragment that scopes any list query,
 * so data access is enforced in SQL rather than filtered in JS after the fact.
 */
import {
  CAPABILITIES,
  type AuthUser,
  type FieldPermission,
  type ModulePermission,
} from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { ForbiddenError } from '../../utils/errors.js';
import { registry } from '../metadata/registry.js';
import { RECORD_ALIAS, type SqlParams } from '../query/builder.js';

export type Action = 'view' | 'create' | 'edit' | 'delete' | 'export' | 'import';

interface ProfileCacheEntry {
  modulePerms: Map<string, ModulePermission>;
  fieldPerms: Map<string, FieldPermission>; // key: fieldId
  capabilities: Set<string>;
  loadedAt: number;
}

const profileCache = new Map<string, ProfileCacheEntry>();
const sharingCache = new Map<string, { access: string; loadedAt: number }>();
let roleTreeCache: Map<string, string[]> | null = null; // roleId → descendant roleIds (inclusive)

const CACHE_TTL_MS = 60_000;

// In-flight load promises — prevents cache stampede when many concurrent requests
// miss the cache at once (e.g. after a permission change invalidates it).
const profileLoadPromises = new Map<string, Promise<ProfileCacheEntry>>();
const sharingLoadPromises = new Map<string, Promise<string>>();
let roleTreeLoadPromise: Promise<Map<string, string[]>> | null = null;

export function invalidatePermissions(): void {
  profileCache.clear();
  sharingCache.clear();
  roleTreeCache = null;
  profileLoadPromises.clear();
  sharingLoadPromises.clear();
  roleTreeLoadPromise = null;
}

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

async function loadProfile(profileId: string, conn: Tx = db): Promise<ProfileCacheEntry> {
  const cached = profileCache.get(profileId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  // Coalesce concurrent loads for the same profile into one DB round-trip.
  const existing = profileLoadPromises.get(profileId);
  if (existing) return existing;

  const promise = (async (): Promise<ProfileCacheEntry> => {
    try {
      const [modRes, fldRes, profRes] = await Promise.all([
        conn.query<{ module_name: string; can_view: boolean; can_create: boolean; can_edit: boolean; can_delete: boolean; can_export: boolean; can_import: boolean }>(
          `SELECT m.name AS module_name, p.can_view, p.can_create, p.can_edit, p.can_delete, p.can_export, p.can_import
           FROM ipy_profile_module_perm p JOIN ipy_module m ON m.id = p.module_id
           WHERE p.profile_id = $1`,
          [profileId],
        ),
        conn.query<{ field_id: string; permission: FieldPermission }>(
          `SELECT field_id, permission FROM ipy_profile_field_perm WHERE profile_id = $1`,
          [profileId],
        ),
        conn.query<{ capabilities: string[] }>(`SELECT capabilities FROM ipy_profile WHERE id = $1`, [profileId]),
      ]);

      const entry: ProfileCacheEntry = {
        modulePerms: new Map(
          modRes.rows.map((r) => [
            r.module_name,
            { view: r.can_view, create: r.can_create, edit: r.can_edit, delete: r.can_delete, export: r.can_export, import: r.can_import },
          ]),
        ),
        fieldPerms: new Map(fldRes.rows.map((r) => [r.field_id, r.permission])),
        capabilities: new Set(profRes.rows[0]?.capabilities ?? []),
        loadedAt: Date.now(),
      };
      profileCache.set(profileId, entry);
      return entry;
    } finally {
      profileLoadPromises.delete(profileId);
    }
  })();

  profileLoadPromises.set(profileId, promise);
  return promise;
}

async function getOrgSharing(moduleName: string, conn: Tx = db): Promise<string> {
  const cached = sharingCache.get(moduleName);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.access;
  const row = await conn.queryOne<{ access: string }>(
    `SELECT s.access FROM ipy_module_sharing s JOIN ipy_module m ON m.id = s.module_id WHERE m.name = $1`,
    [moduleName],
  );
  const access = row?.access ?? 'private';
  sharingCache.set(moduleName, { access, loadedAt: Date.now() });
  return access;
}

/** roleId → itself plus every descendant role id. */
async function getRoleTree(conn: Tx = db): Promise<Map<string, string[]>> {
  if (roleTreeCache) return roleTreeCache;
  // Coalesce concurrent loads into one DB round-trip, like the profile and
  // sharing caches above: after an invalidation, a burst of requests would
  // otherwise each run the full role query. The promise was declared and
  // cleared but never consulted — half a stampede fix.
  const existing = roleTreeLoadPromise;
  if (existing) return existing;

  const promise = (async (): Promise<Map<string, string[]>> => {
    const res = await conn.query<{ id: string; path: string[] }>(`SELECT id, path FROM ipy_role`);
    const map = new Map<string, string[]>();
    for (const role of res.rows) {
      map.set(role.id, [role.id]);
    }
    for (const role of res.rows) {
      // every ancestor in `path` also "contains" this role
      for (const ancestor of role.path ?? []) {
        const list = map.get(ancestor);
        if (list && !list.includes(role.id)) list.push(role.id);
      }
    }
    return map;
  })();

  roleTreeLoadPromise = promise;
  try {
    const map = await promise;
    roleTreeCache = map;
    return map;
  } finally {
    roleTreeLoadPromise = null;
  }
}

/**
 * Users whose records a given user can see via the role hierarchy — the people
 * *below* them, and nobody else.
 *
 * The user's own role is deliberately excluded. `getRoleTree` maps a role to
 * itself plus its descendants, which is right for a `role_and_subordinates`
 * sharing rule but wrong here: keeping the own-role entry made every colleague
 * sharing a job title a "subordinate", so two Sales Executives each held full
 * read *and write* access to the other's leads and `private` sharing meant
 * nothing. In a brokerage that is one rep quietly working another rep's
 * pipeline, which is the exact thing record ownership exists to prevent.
 *
 * A manager still sees their reports: Sales Executive sits under Regional Sales
 * Manager under Administrator, so those roles are descendants rather than peers.
 * Two people who genuinely should share a queue get a sharing rule or a group,
 * both of which say so explicitly.
 */
export async function getSubordinateUserIds(user: Pick<AuthUser, 'id' | 'roleId'>, conn: Tx = db): Promise<string[]> {
  if (!user.roleId) return [];
  const tree = await getRoleTree(conn);
  const roleIds = (tree.get(user.roleId) ?? []).filter((id) => id !== user.roleId);
  if (!roleIds.length) return [];
  const res = await conn.query<{ id: string }>(
    `SELECT id FROM ipy_user WHERE role_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [roleIds],
  );
  return res.rows.map((r) => r.id).filter((id) => id !== user.id);
}

// ---------------------------------------------------------------------------
// Module / capability checks
// ---------------------------------------------------------------------------

export async function getModulePermission(user: AuthUser, moduleName: string): Promise<ModulePermission> {
  if (user.isAdmin) {
    return { view: true, create: true, edit: true, delete: true, export: true, import: true };
  }
  if (!user.profileId) {
    return { view: false, create: false, edit: false, delete: false, export: false, import: false };
  }
  const profile = await loadProfile(user.profileId);
  return (
    profile.modulePerms.get(moduleName) ?? {
      view: false, create: false, edit: false, delete: false, export: false, import: false,
    }
  );
}

export async function canAccessModule(user: AuthUser, moduleName: string, action: Action): Promise<boolean> {
  const perm = await getModulePermission(user, moduleName);
  return perm[action] === true;
}

export async function assertModuleAccess(user: AuthUser, moduleName: string, action: Action): Promise<void> {
  if (!(await canAccessModule(user, moduleName, action))) {
    const mod = await registry.getModule(moduleName);
    throw new ForbiddenError(`You do not have permission to ${action} ${mod?.label ?? moduleName}`);
  }
}

export async function hasCapability(user: AuthUser, capability: string): Promise<boolean> {
  if (user.isAdmin) return true;
  if (!user.profileId) return false;
  const profile = await loadProfile(user.profileId);
  return profile.capabilities.has(capability);
}

/**
 * Everything this person may do, for the browser to decide what to show.
 *
 * The same source `hasCapability` reads, so the screen and the server cannot
 * disagree about who may open what. An admin holds all of them implicitly, and
 * says so explicitly here rather than making every caller remember the special
 * case.
 */
export async function listCapabilities(user: AuthUser): Promise<string[]> {
  if (user.isAdmin) return [...CAPABILITIES];
  if (!user.profileId) return [];
  const profile = await loadProfile(user.profileId);
  return [...profile.capabilities].sort();
}

export async function assertCapability(user: AuthUser, capability: string): Promise<void> {
  if (!(await hasCapability(user, capability))) {
    throw new ForbiddenError(`Missing permission: ${capability}`);
  }
}

// ---------------------------------------------------------------------------
// Field-level permissions
// ---------------------------------------------------------------------------

export async function getFieldPermissions(
  user: AuthUser,
  moduleName: string,
): Promise<Map<string, FieldPermission>> {
  const module = await registry.requireModule(moduleName);
  const out = new Map<string, FieldPermission>();
  if (user.isAdmin || !user.profileId) {
    for (const f of module.fields) out.set(f.name, f.isReadonly ? 'readonly' : 'editable');
    return out;
  }
  const profile = await loadProfile(user.profileId);
  for (const f of module.fields) {
    const explicit = profile.fieldPerms.get(f.id);
    const base: FieldPermission = explicit ?? 'editable';
    out.set(f.name, f.isReadonly && base === 'editable' ? 'readonly' : base);
  }
  return out;
}

/** Strip fields the user may not see from an outbound value bag. */
export async function filterReadableFields<T extends Record<string, unknown>>(
  user: AuthUser,
  moduleName: string,
  values: T,
): Promise<T> {
  if (user.isAdmin) return values;
  const perms = await getFieldPermissions(user, moduleName);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (perms.get(key) === 'hidden') continue;
    out[key] = value;
  }
  return out as T;
}

/** Drop fields the user may not write, so a crafted payload can't set them. */
export async function filterWritableFields(
  user: AuthUser,
  moduleName: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  /*
    Two different ideas used to share one gate, and the admin bypass swallowed
    both.

    A **profile permission** is about privilege: this rep may not edit the
    budget. An admin overriding that is the whole point of being an admin.

    `isReadonly` is not about privilege. It says the value is computed —
    `rating` is the band of `ai_score`, `lifecycle_stage` follows the pipeline
    status — and typing into a computed field does not become allowed because
    you are an admin. It becomes silently discarded, which is what happened:
    the API answered 200, the audit trail recorded the change as successful, and
    the scorer overwrote it moments later.

    So the readonly check runs for everybody and the profile check does not.
    System writes never reach here at all: `updateRecord` skips this entirely
    when `ctx.system` is set, which is how scoring writes `rating` in the first
    place.
  */
  const module = await registry.requireModule(moduleName);
  const computed = new Set(module.fields.filter((f) => f.isReadonly).map((f) => f.name));

  const perms = user.isAdmin ? null : await getFieldPermissions(user, moduleName);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (computed.has(key)) continue;
    if (perms && perms.get(key) !== 'editable') continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record-level scoping
// ---------------------------------------------------------------------------

export interface ScopeContext {
  user: AuthUser;
  subordinateIds: string[];
  groupIds: string[];
}

/**
 * WHERE fragment restricting a list query to records the user may read.
 * Returns null when no restriction is needed (admin / public module).
 */
export async function recordScopeSql(
  ctx: ScopeContext,
  moduleName: string,
  params: SqlParams,
  requireWrite = false,
): Promise<string | null> {
  const { user } = ctx;
  if (user.isAdmin) return null;
  if (await hasCapability(user, 'records.view_all') && !requireWrite) return null;

  const orgAccess = await getOrgSharing(moduleName);
  if (!requireWrite && (orgAccess === 'public_read' || orgAccess === 'public_read_write' || orgAccess === 'public_read_write_delete')) {
    return null;
  }
  if (requireWrite && (orgAccess === 'public_read_write' || orgAccess === 'public_read_write_delete')) {
    return null;
  }

  // Owners the user can act for: self, subordinates, and their groups.
  const ownerIds = [user.id, ...ctx.subordinateIds, ...ctx.groupIds];

  // Sharing rules that grant this user access to other principals' records.
  const granted = await getSharedOwnerIds(ctx, moduleName, requireWrite);
  ownerIds.push(...granted);

  const ownerParam = params.add([...new Set(ownerIds)]);
  const userParam = params.add(user.id);
  const subjectsParam = params.add([...new Set([user.id, ...ctx.groupIds, ...(user.roleId ? [user.roleId] : [])])]);
  const accessClause = requireWrite ? `AND rs.access = 'read_write'` : '';

  return `(
    ${RECORD_ALIAS}.owner_id = ANY(${ownerParam}::uuid[])
    OR ${RECORD_ALIAS}.created_by = ${userParam}::uuid
    OR EXISTS (
      SELECT 1 FROM ipy_record_share rs
      WHERE rs.record_id = ${RECORD_ALIAS}.id
        AND rs.subject_id = ANY(${subjectsParam}::uuid[])
        ${accessClause}
    )
  )`;
}

/** Principals whose records flow to this user through sharing rules. */
async function getSharedOwnerIds(ctx: ScopeContext, moduleName: string, requireWrite: boolean, conn: Tx = db): Promise<string[]> {
  const { user } = ctx;
  const myPrincipals = [user.id, ...ctx.groupIds, ...(user.roleId ? [user.roleId] : [])];
  const rules = await conn.query<{ from_type: string; from_id: string | null; access: string }>(
    `SELECT sr.from_type, sr.from_id, sr.access
     FROM ipy_sharing_rule sr JOIN ipy_module m ON m.id = sr.module_id
     WHERE m.name = $1 AND sr.is_active
       AND (sr.to_type = 'all' OR sr.to_id = ANY($2::uuid[]))
       ${requireWrite ? `AND sr.access = 'read_write'` : ''}`,
    [moduleName, myPrincipals],
  );
  if (!rules.rows.length) return [];

  const out: string[] = [];
  const tree = await getRoleTree(conn);
  for (const rule of rules.rows) {
    if (!rule.from_id) continue;
    if (rule.from_type === 'user') {
      out.push(rule.from_id);
    } else if (rule.from_type === 'group') {
      out.push(rule.from_id);
      const members = await conn.query<{ member_id: string }>(
        `SELECT member_id FROM ipy_group_member WHERE group_id = $1 AND member_type = 'user'`,
        [rule.from_id],
      );
      out.push(...members.rows.map((r) => r.member_id));
    } else if (rule.from_type === 'role' || rule.from_type === 'role_and_subordinates') {
      const roleIds = rule.from_type === 'role_and_subordinates'
        ? (tree.get(rule.from_id) ?? [rule.from_id])
        : [rule.from_id];
      const users = await conn.query<{ id: string }>(
        `SELECT id FROM ipy_user WHERE role_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [roleIds],
      );
      out.push(...users.rows.map((r) => r.id));
    }
  }
  return [...new Set(out)];
}

/** Per-record check used on detail/edit/delete paths. */
export async function canAccessRecord(
  ctx: ScopeContext,
  moduleName: string,
  recordId: string,
  action: 'view' | 'edit' | 'delete',
  conn: Tx = db,
): Promise<boolean> {
  const { user } = ctx;
  if (user.isAdmin) return true;

  const modulePerm = await getModulePermission(user, moduleName);
  if (action === 'view' && !modulePerm.view) return false;
  if (action === 'edit' && !modulePerm.edit) return false;
  if (action === 'delete' && !modulePerm.delete) return false;

  // Mirrors recordScopeSql: a user who can list every record must also be able
  // to open one. Without this, `records.view_all` produces rows the detail view
  // then refuses to load.
  if (action === 'view' && await hasCapability(user, 'records.view_all')) return true;

  const record = await conn.queryOne<{ owner_id: string | null; created_by: string | null }>(
    `SELECT owner_id, created_by FROM ipy_record WHERE id = $1`,
    [recordId],
  );
  if (!record) return false;

  if (record.owner_id === user.id || record.created_by === user.id) return true;
  if (record.owner_id && ctx.groupIds.includes(record.owner_id)) return true;
  if (record.owner_id && ctx.subordinateIds.includes(record.owner_id)) return true;

  const orgAccess = await getOrgSharing(moduleName, conn);
  if (action === 'view' && orgAccess !== 'private') return true;
  if (action === 'edit' && (orgAccess === 'public_read_write' || orgAccess === 'public_read_write_delete')) return true;
  if (action === 'delete' && orgAccess === 'public_read_write_delete') return true;

  // explicit share
  const share = await conn.queryOne<{ access: string }>(
    `SELECT access FROM ipy_record_share
     WHERE record_id = $1 AND subject_id = ANY($2::uuid[])
     ORDER BY CASE access WHEN 'read_write' THEN 0 ELSE 1 END LIMIT 1`,
    [recordId, [user.id, ...ctx.groupIds, ...(user.roleId ? [user.roleId] : [])]],
  );
  if (share) {
    if (action === 'view') return true;
    if (share.access === 'read_write') return action !== 'delete';
  }

  // sharing rules
  const sharedOwners = await getSharedOwnerIds(ctx, moduleName, action !== 'view', conn);
  if (record.owner_id && sharedOwners.includes(record.owner_id)) return true;

  return false;
}

export async function assertRecordAccess(
  ctx: ScopeContext,
  moduleName: string,
  recordId: string,
  action: 'view' | 'edit' | 'delete',
  conn: Tx = db,
): Promise<void> {
  if (!(await canAccessRecord(ctx, moduleName, recordId, action, conn))) {
    throw new ForbiddenError(`You do not have permission to ${action} this record`);
  }
}

/** Build the scope context once per request. */
export async function buildScopeContext(user: AuthUser, conn: Tx = db): Promise<ScopeContext> {
  const [subordinateIds, groupRes] = await Promise.all([
    getSubordinateUserIds(user, conn),
    conn.query<{ group_id: string }>(
      `SELECT DISTINCT gm.group_id
       FROM ipy_group_member gm
       WHERE (gm.member_type = 'user' AND gm.member_id = $1)
          OR (gm.member_type = 'role' AND gm.member_id = $2)`,
      [user.id, user.roleId],
    ),
  ]);
  return {
    user,
    subordinateIds,
    groupIds: groupRes.rows.map((r) => r.group_id),
  };
}
