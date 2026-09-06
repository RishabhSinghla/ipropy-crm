/**
 * Unit tests for core/permissions/index.ts — the four-layer permission engine.
 *
 * The engine reads profile/sharing/role data through `db/pool.js` and metadata
 * through the registry; both are stubbed here so the pure decision logic can be
 * exercised without Postgres. Every test starts from a clean cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@ipropy/shared';
import { SqlParams } from '../../src/core/query/builder.js';
import {
  assertModuleAccess,
  buildScopeContext,
  canAccessRecord,
  canAccessModule,
  filterReadableFields,
  filterWritableFields,
  getFieldPermissions,
  getModulePermission,
  getSubordinateUserIds,
  hasCapability,
  invalidatePermissions,
  recordScopeSql,
  type ScopeContext,
} from '../../src/core/permissions/index.js';
import { field, module } from '../helpers.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const poolState = vi.hoisted(() => {
  type Handler = { sql: string; rows: unknown[] };
  const handlers: Handler[] = [];
  const query = vi.fn(async (sql: string) => {
    const rows = handlers.find((h) => sql.includes(h.sql))?.rows ?? [];
    return { rows, rowCount: rows.length };
  });
  const queryOne = vi.fn(async (sql: string) => {
    return handlers.find((h) => sql.includes(h.sql))?.rows?.[0] ?? null;
  });
  return { handlers, query, queryOne };
});

vi.mock('../../src/db/pool.js', () => ({
  db: { query: poolState.query, queryOne: poolState.queryOne },
  onCommit: vi.fn(),
  transaction: vi.fn(),
}));

const regState = vi.hoisted(() => {
  const mods = new Map<string, ReturnType<typeof module>>();
  return {
    mods,
    registry: {
      requireModule: vi.fn(async (name: string) => {
        const m = mods.get(name);
        if (!m) throw new Error(`no such module ${name}`);
        return m;
      }),
      getModule: vi.fn(async (name: string) => mods.get(name) ?? null),
    },
  };
});

vi.mock('../../src/core/metadata/registry.js', () => ({ registry: regState.registry }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_MODULE_PERMS = {
  can_view: true, can_create: true, can_edit: true, can_delete: true, can_export: true, can_import: true,
};

function user(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u_1',
    email: 'user@ipropy.com',
    firstName: 'Test',
    lastName: 'User',
    fullName: 'Test User',
    avatarUrl: null,
    phone: null,
    isAdmin: false,
    isActive: true,
    roleId: 'r2',
    roleName: 'Sales Manager',
    profileId: 'p1',
    profileName: 'Sales',
    groupIds: ['g1'],
    timezone: 'Asia/Kolkata',
    locale: 'en',
    currency: 'INR',
    theme: 'system',
    defaultDashboardId: null,
    channelPartnerId: null,
    lastLoginAt: null,
    ...over,
  };
}

function admin(): AuthUser {
  return user({ id: 'u_admin', isAdmin: true });
}

function scopeCtx(u: AuthUser, over: Partial<ScopeContext> = {}): ScopeContext {
  return { user: u, subordinateIds: [], groupIds: u.groupIds, ...over };
}

const leadsModule = () =>
  module({
    name: 'leads',
    fields: [
      field({ name: 'first_name', uitype: 'string' }),
      field({ name: 'status', uitype: 'picklist' }),
      field({ name: 'converted_at', uitype: 'datetime', isReadonly: true }),
    ],
  });

/** Register a stub DB response, replacing any earlier one for the same SQL. */
function on(sqlLike: string, rows: unknown[]) {
  const handler = { sql: sqlLike, rows };
  const idx = poolState.handlers.findIndex((h) => h.sql === sqlLike);
  if (idx >= 0) poolState.handlers[idx] = handler;
  else poolState.handlers.push(handler);
}

function resetDb() {
  poolState.handlers.length = 0;
}

beforeEach(() => {
  invalidatePermissions();
  regState.mods.clear();
  regState.mods.set('leads', leadsModule());
  resetDb();

  // Default profile/sharing/role data — individual tests override what they need.
  on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
  on('SELECT field_id, permission', []);
  on('SELECT capabilities', [{ capabilities: [] }]);
  on('FROM ipy_module_sharing', [{ access: 'private' }]);
  on('FROM ipy_role', [
    { id: 'r1', path: [] },
    { id: 'r2', path: ['r1'] },
  ]);
  on('FROM ipy_sharing_rule', []);
  on('FROM ipy_group_member', []);
  on('SELECT id FROM ipy_user', []);
  on('SELECT owner_id, created_by FROM ipy_record', []);
  on('FROM ipy_record_share', []);
});

// ---------------------------------------------------------------------------
// Admin short-circuits
// ---------------------------------------------------------------------------

describe('admin', () => {
  it('has every module permission and capability', async () => {
    expect(await getModulePermission(admin(), 'leads')).toEqual({
      view: true, create: true, edit: true, delete: true, export: true, import: true,
    });
    expect(await hasCapability(admin(), 'anything.at.all')).toBe(true);
    expect(await canAccessModule(admin(), 'leads', 'view')).toBe(true);
  });

  it('recordScopeSql needs no WHERE fragment', async () => {
    expect(await recordScopeSql(scopeCtx(admin()), 'leads', new SqlParams())).toBeNull();
    expect(await recordScopeSql(scopeCtx(admin()), 'leads', new SqlParams(), true)).toBeNull();
  });

  it('canAccessRecord is always true', async () => {
    expect(await canAccessRecord(scopeCtx(admin()), 'leads', 'any-id', 'view')).toBe(true);
    expect(await canAccessRecord(scopeCtx(admin()), 'leads', 'any-id', 'delete')).toBe(true);
  });

  it('field filters pass values through untouched', async () => {
    const values = { status: 'New', first_name: 'R' };
    expect(await filterReadableFields(admin(), 'leads', values)).toEqual(values);
    expect(await filterWritableFields(admin(), 'leads', values)).toEqual(values);
  });

  it('field permissions default to editable/readonly from metadata', async () => {
    const perms = await getFieldPermissions(admin(), 'leads');
    expect(perms.get('status')).toBe('editable');
    expect(perms.get('converted_at')).toBe('readonly');
  });
});

// ---------------------------------------------------------------------------
// Module-level checks
// ---------------------------------------------------------------------------

describe('module permissions', () => {
  it('denies modules not granted to the profile', async () => {
    expect(await canAccessModule(user(), 'deals', 'view')).toBe(false);
    await expect(assertModuleAccess(user(), 'deals', 'view')).rejects.toThrow(/permission/);
  });

  it('grants modules the profile can touch', async () => {
    expect(await canAccessModule(user(), 'leads', 'view')).toBe(true);
    expect(await canAccessModule(user(), 'leads', 'edit')).toBe(true);
    await expect(assertModuleAccess(user(), 'leads', 'view')).resolves.toBeUndefined();
  });

  it('enforces per-action flags from the profile', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS, can_delete: false }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    expect(await canAccessModule(user(), 'leads', 'view')).toBe(true);
    expect(await canAccessModule(user(), 'leads', 'delete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordScopeSql
// ---------------------------------------------------------------------------

describe('recordScopeSql', () => {
  it('returns null for a records.view_all user unless a write scope is required', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: ['records.view_all'] }]);
    on('FROM ipy_module_sharing', [{ access: 'private' }]);

    const p = new SqlParams();
    expect(await recordScopeSql(scopeCtx(user()), 'leads', p)).toBeNull();

    const p2 = new SqlParams();
    const sql = await recordScopeSql(scopeCtx(user()), 'leads', p2, true);
    expect(sql).toContain('r.owner_id = ANY($1::uuid[])');
    expect(sql).toContain("AND rs.access = 'read_write'");
    expect(p2.all()).toEqual([[user().id, 'g1'], user().id, [user().id, 'g1', 'r2']]);
  });

  it('scopes private modules to owner/created-by/group/explicit shares', async () => {
    const p = new SqlParams();
    const sql = await recordScopeSql(scopeCtx(user()), 'leads', p);
    expect(sql).toContain('r.owner_id = ANY($1::uuid[])');
    expect(sql).toContain('r.created_by = $2::uuid');
    expect(sql).toContain('rs.subject_id = ANY($3::uuid[])');
    expect(p.all()).toEqual([[user().id, 'g1'], user().id, [user().id, 'g1', 'r2']]);
  });

  it('lifts the scope for public-read modules on read, but not on write', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    on('FROM ipy_module_sharing', [{ access: 'public_read' }]);

    expect(await recordScopeSql(scopeCtx(user()), 'leads', new SqlParams())).toBeNull();
    expect(await recordScopeSql(scopeCtx(user()), 'leads', new SqlParams(), true)).not.toBeNull();
  });

  it('lifts the scope entirely for public read-write modules', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    on('FROM ipy_module_sharing', [{ access: 'public_read_write' }]);

    expect(await recordScopeSql(scopeCtx(user()), 'leads', new SqlParams())).toBeNull();
    expect(await recordScopeSql(scopeCtx(user()), 'leads', new SqlParams(), true)).toBeNull();
  });

  it('includes owners granted through sharing rules in the owner list', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    on('FROM ipy_module_sharing', [{ access: 'private' }]);
    on('FROM ipy_sharing_rule', [{ from_type: 'user', from_id: 'u_2', access: 'read_write' }]);

    const p = new SqlParams();
    await recordScopeSql(scopeCtx(user()), 'leads', p);
    expect(p.all()[0]).toEqual(['u_1', 'g1', 'u_2']);
  });

  it('expands role sharing rules to every user in the role tree', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    on('FROM ipy_module_sharing', [{ access: 'private' }]);
    on('FROM ipy_sharing_rule', [{ from_type: 'role_and_subordinates', from_id: 'r1', access: 'read_write' }]);
    on('SELECT id FROM ipy_user', [{ id: 'u_2' }]);

    const p = new SqlParams();
    await recordScopeSql(scopeCtx(user()), 'leads', p);
    expect(p.all()[0]).toEqual(['u_1', 'g1', 'u_2']);
  });
});

// ---------------------------------------------------------------------------
// canAccessRecord
// ---------------------------------------------------------------------------

describe('canAccessRecord', () => {
  const recordOwnedBy = (ownerId: string | null, createdBy = 'someone-else') =>
    on('SELECT owner_id, created_by FROM ipy_record', [{ owner_id: ownerId, created_by: createdBy }]);

  it('lets the owner in', async () => {
    recordOwnedBy('u_1');
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(true);
  });

  it('lets the creator in', async () => {
    recordOwnedBy('someone-else', 'u_1');
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(true);
  });

  it('lets a group owner in', async () => {
    recordOwnedBy('g1');
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(true);
  });

  it('lets a manager see a subordinate-owned record', async () => {
    recordOwnedBy('u_2');
    expect(await canAccessRecord(scopeCtx(user(), { subordinateIds: ['u_2'] }), 'leads', 'rec', 'view')).toBe(true);
  });

  it('grants view (not edit) on public-read modules', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    on('FROM ipy_module_sharing', [{ access: 'public_read' }]);
    recordOwnedBy('u_9');

    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(true);
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'edit')).toBe(false);
  });

  it('honours explicit read_write shares for edit but not delete', async () => {
    on('FROM ipy_record_share', [{ access: 'read_write' }]);
    recordOwnedBy('u_9');
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(true);
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'edit')).toBe(true);
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'delete')).toBe(false);
  });

  it('honours read-only shares for view only', async () => {
    on('FROM ipy_record_share', [{ access: 'read_only' }]);
    recordOwnedBy('u_9');
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(true);
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'edit')).toBe(false);
  });

  it('grants access through a sharing rule to the record owner', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    on('FROM ipy_module_sharing', [{ access: 'private' }]);
    on('FROM ipy_sharing_rule', [{ from_type: 'role', from_id: 'r1', access: 'read_write' }]);
    on('SELECT id FROM ipy_user', [{ id: 'u_2' }]);
    recordOwnedBy('u_2');

    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(true);
  });

  it('denies a record the user has no relationship to', async () => {
    recordOwnedBy('u_9');
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(false);
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'edit')).toBe(false);
  });

  it('denies when the profile cannot even see the module', async () => {
    resetDb();
    on('SELECT m.name AS module_name', []);
    on('SELECT field_id, permission', []);
    on('SELECT capabilities', [{ capabilities: [] }]);
    expect(await canAccessRecord(scopeCtx(user()), 'leads', 'rec', 'view')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Field-level permissions
// ---------------------------------------------------------------------------

describe('field-level permissions', () => {
  it('strips hidden fields from responses and keeps readonly ones', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', [{ field_id: 'f_leads_status', permission: 'hidden' }]);
    on('SELECT capabilities', [{ capabilities: [] }]);

    const values = { status: 'New', first_name: 'R', converted_at: '2026-08-01' };
    expect(await filterReadableFields(user(), 'leads', values)).toEqual({ first_name: 'R', converted_at: '2026-08-01' });
  });

  it('filterWritableFields keeps only explicitly editable fields', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', [
      { field_id: 'f_leads_status', permission: 'readonly' },
      { field_id: 'f_leads_first_name', permission: 'editable' },
    ]);
    on('SELECT capabilities', [{ capabilities: [] }]);

    const values = { status: 'New', first_name: 'R', converted_at: '2026-08-01' };
    expect(await filterWritableFields(user(), 'leads', values)).toEqual({ first_name: 'R' });
  });

  it('field permission lookup reflects profile overrides on top of metadata readonly', async () => {
    resetDb();
    on('SELECT m.name AS module_name', [{ module_name: 'leads', ...FULL_MODULE_PERMS }]);
    on('SELECT field_id, permission', [{ field_id: 'f_leads_status', permission: 'hidden' }]);
    on('SELECT capabilities', [{ capabilities: [] }]);

    const perms = await getFieldPermissions(user(), 'leads');
    expect(perms.get('status')).toBe('hidden');
    expect(perms.get('first_name')).toBe('editable');
    expect(perms.get('converted_at')).toBe('readonly');
  });
});

// ---------------------------------------------------------------------------
// buildScopeContext
// ---------------------------------------------------------------------------

describe('buildScopeContext', () => {
  it('collects subordinate users through the role tree and group memberships', async () => {
    // A real tree, not an empty one: the user sits at r2 with r3 beneath it.
    // This used to stub no roles at all and still pass, because the lookup fell
    // back to the user's *own* role — which is precisely the bug that let a
    // colleague sharing a job title be counted as a subordinate.
    on('FROM ipy_role', [{ id: 'r2', path: [] }, { id: 'r3', path: ['r2'] }]);
    on('SELECT id FROM ipy_user', [{ id: 'u_2' }]);
    on('FROM ipy_group_member', [{ group_id: 'g1' }]);

    const scoped = await buildScopeContext(user());
    expect(scoped.user.id).toBe('u_1');
    expect(scoped.subordinateIds).toEqual(['u_2']);
    expect(scoped.groupIds).toEqual(['g1']);
  });

  it('gives a user with no one below them an empty subordinate list', async () => {
    // The same stubs as above except the tree has no descendant of r2, so a
    // fallback to "everyone in my own role" would show up as a leak here.
    on('FROM ipy_role', [{ id: 'r2', path: [] }]);
    on('SELECT id FROM ipy_user', [{ id: 'u_peer' }]);
    on('FROM ipy_group_member', []);

    const scoped = await buildScopeContext(user());
    expect(scoped.subordinateIds).toEqual([]);
  });

  it('returns empty lists for a user with no role', async () => {
    on('FROM ipy_group_member', []);
    const scoped = await buildScopeContext(user({ roleId: null }));
    expect(scoped.subordinateIds).toEqual([]);
    expect(scoped.groupIds).toEqual([]);
  });
});

/**
 * Peers are not subordinates.
 *
 * `getRoleTree` maps a role to itself plus its descendants, which is correct
 * for a `role_and_subordinates` sharing rule and wrong for "who reports to me".
 * Keeping the own-role entry made everyone sharing a job title a subordinate,
 * so two Sales Executives each had full read *and write* access to the other's
 * leads while the module was configured `private`. These pin the boundary.
 */
describe('getSubordinateUserIds', () => {
  const ROLES = [
    { id: 'r_head', path: [] },
    { id: 'r_mgr', path: ['r_head'] },
    { id: 'r_exec', path: ['r_head', 'r_mgr'] },
  ];

  /** Users keyed by the role ids the query asked for. */
  function onUsersByRole(byRole: Record<string, string[]>) {
    poolState.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM ipy_role')) return { rows: ROLES, rowCount: ROLES.length };
      if (sql.includes('FROM ipy_user WHERE role_id')) {
        const asked = (params?.[0] ?? []) as string[];
        const rows = asked.flatMap((r) => (byRole[r] ?? []).map((id) => ({ id })));
        return { rows, rowCount: rows.length };
      }
      const rows = poolState.handlers.find((h) => sql.includes(h.sql))?.rows ?? [];
      return { rows, rowCount: rows.length };
    });
  }

  const population = {
    r_head: ['u_head'],
    r_mgr: ['u_mgr'],
    r_exec: ['u_execA', 'u_execB', 'u_execC'],
  };

  it('does not treat a colleague in the same role as a subordinate', async () => {
    onUsersByRole(population);
    const subs = await getSubordinateUserIds({ id: 'u_execA', roleId: 'r_exec' });
    expect(subs).toEqual([]);
  });

  it('still gives a manager everyone below them', async () => {
    onUsersByRole(population);
    const subs = await getSubordinateUserIds({ id: 'u_mgr', roleId: 'r_mgr' });
    expect(subs.sort()).toEqual(['u_execA', 'u_execB', 'u_execC']);
    expect(subs).not.toContain('u_mgr');
  });

  it('gives the top of the tree everyone underneath, at every depth', async () => {
    onUsersByRole(population);
    const subs = await getSubordinateUserIds({ id: 'u_head', roleId: 'r_head' });
    expect(subs.sort()).toEqual(['u_execA', 'u_execB', 'u_execC', 'u_mgr']);
  });

  it('returns nothing for a user with no role at all', async () => {
    onUsersByRole(population);
    expect(await getSubordinateUserIds({ id: 'u_x', roleId: null })).toEqual([]);
  });
});
