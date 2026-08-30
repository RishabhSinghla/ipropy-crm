import bcrypt from 'bcryptjs';
import { CAPABILITIES } from '@ipropy/shared';
import { config } from '../../config.js';
import type { Tx } from '../pool.js';

/**
 * Roles, profiles, users and sharing defaults for a typical developer/broker
 * sales organisation. The hierarchy drives data visibility: a Sales Head sees
 * everything under them without any explicit sharing rule.
 */

interface RoleDef {
  name: string;
  children?: RoleDef[];
}

const ROLE_TREE: RoleDef = {
  name: 'CEO',
  children: [
    {
      name: 'Sales Head',
      children: [
        {
          name: 'Regional Sales Manager',
          children: [
            { name: 'Sales Manager', children: [{ name: 'Sales Executive' }, { name: 'Tele-caller' }] },
            {
              name: 'Channel Partner Manager',
              children: [{ name: 'Channel Partner' }],
            },
          ],
        },
        { name: 'Pre-Sales Manager', children: [{ name: 'Pre-Sales Executive' }] },
      ],
    },
    { name: 'Marketing Head', children: [{ name: 'Marketing Executive' }] },
    { name: 'CRM Head', children: [{ name: 'CRM Executive' }, { name: 'Collections Executive' }] },
    { name: 'Finance Head', children: [{ name: 'Accounts Executive' }] },
  ],
};

export async function seedRoles(conn: Tx): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  async function insert(def: RoleDef, parentId: string | null, parentPath: string[], depth: number): Promise<void> {
    const existing = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_role WHERE name = $1`, [def.name]);
    let id: string;
    if (existing) {
      id = existing.id;
      await conn.query(`UPDATE ipy_role SET parent_id = $2, depth = $3, path = $4 WHERE id = $1`, [
        id, parentId, depth, parentPath,
      ]);
    } else {
      const row = await conn.queryOne<{ id: string }>(
        `INSERT INTO ipy_role (name, parent_id, depth, path, sequence) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [def.name, parentId, depth, parentPath, depth * 10],
      );
      id = row!.id;
    }
    ids.set(def.name, id);
    for (const child of def.children ?? []) {
      await insert(child, id, [...parentPath, id], depth + 1);
    }
  }

  await insert(ROLE_TREE, null, [], 0);
  return ids;
}

interface ProfileDef {
  name: string;
  description: string;
  capabilities: string[];
  /** module → [view, create, edit, delete, export, import] */
  modules: Record<string, [boolean, boolean, boolean, boolean, boolean, boolean]>;
  /** fields hidden or made readonly for this profile */
  fieldOverrides?: Record<string, Record<string, 'hidden' | 'readonly'>>;
}

const ALL = ['leads', 'properties'];

function perms(
  modules: string[],
  p: [boolean, boolean, boolean, boolean, boolean, boolean],
): Record<string, [boolean, boolean, boolean, boolean, boolean, boolean]> {
  return Object.fromEntries(modules.map((m) => [m, p]));
}

const PROFILES: ProfileDef[] = [
  {
    name: 'Administrator',
    description: 'Full access to data and all admin settings.',
    capabilities: [...CAPABILITIES],
    modules: perms(ALL, [true, true, true, true, true, true]),
  },
  {
    name: 'Sales Head',
    description: 'Sees the whole sales org, approves discounts, cannot change system metadata.',
    capabilities: [
      'records.export', 'records.import', 'records.mass_edit', 'records.transfer_ownership',
      'records.view_all', 'dashboards.share', 'ai.use', 'telephony.call',
      'telephony.listen_recordings', 'whatsapp.send', 'whatsapp.templates',
      'inventory.block_unit', 'inventory.change_price', 'bookings.approve_discount', 'admin.audit',
    ],
    modules: {
      ...perms(ALL, [true, true, true, true, true, false]),
      payments: [true, true, true, false, true, false],
    },
  },
  {
    name: 'Sales Manager',
    description: 'Manages a team, full access to their pipeline.',
    capabilities: [
      'records.export', 'records.mass_edit', 'records.transfer_ownership', 'ai.use',
      'telephony.call', 'telephony.listen_recordings', 'whatsapp.send', 'inventory.block_unit',
    ],
    modules: {
      ...perms(ALL, [true, true, true, false, true, false]),
      properties: [true, false, true, false, true, false],
      payments: [true, false, false, false, false, false],
    },
  },
  {
    name: 'Sales Executive',
    description: 'Works their own leads and deals. Read-only on inventory.',
    capabilities: ['ai.use', 'telephony.call', 'whatsapp.send'],
    modules: {
      leads: [true, true, true, false, false, false],
      contacts: [true, true, true, false, false, false],
      organizations: [true, true, true, false, false, false],
      properties: [true, false, false, false, false, false],
      deals: [true, true, true, false, false, false],
      site_visits: [true, true, true, false, false, false],
      bookings: [true, true, true, false, false, false],
      payments: [true, false, false, false, false, false],
      channel_partners: [true, false, false, false, false, false],
      documents: [true, true, true, false, false, false],
    },
    fieldOverrides: {
      properties: { base_price: 'readonly', rate_per_sqft: 'readonly', total_price: 'readonly' },
      bookings: { broker_commission: 'hidden', commission_status: 'hidden' },
      channel_partners: { commission_percent: 'hidden', commission_slab: 'hidden', bank_details: 'hidden' },
    },
  },
  {
    name: 'Pre-Sales / Tele-caller',
    description: 'Qualifies inbound leads and books site visits. No pricing visibility.',
    capabilities: ['ai.use', 'telephony.call', 'whatsapp.send'],
    modules: {
      leads: [true, true, true, false, false, false],
      contacts: [true, true, true, false, false, false],
      properties: [true, false, false, false, false, false],
      site_visits: [true, true, true, false, false, false],
      deals: [true, false, false, false, false, false],
      organizations: [true, false, false, false, false, false],
      bookings: [false, false, false, false, false, false],
      payments: [false, false, false, false, false, false],
      channel_partners: [true, false, false, false, false, false],
      documents: [true, true, false, false, false, false],
    },
    fieldOverrides: {
      properties: { base_price: 'hidden', rate_per_sqft: 'hidden', total_price: 'hidden', plc_charge: 'hidden', floor_rise_charge: 'hidden' },
      leads: { budget_min: 'readonly', budget_max: 'readonly' },
    },
  },
  {
    name: 'CRM / Post-Sales',
    description: 'Owns bookings, documentation, collections and customer service after the sale.',
    capabilities: ['records.export', 'ai.use', 'whatsapp.send', 'telephony.call'],
    modules: {
      leads: [true, false, false, false, false, false],
      contacts: [true, true, true, false, true, false],
      organizations: [true, true, true, false, false, false],
      properties: [true, false, true, false, false, false],
      deals: [true, false, true, false, false, false],
      site_visits: [true, true, true, false, false, false],
      bookings: [true, true, true, false, true, false],
      payments: [true, true, true, false, true, true],
      channel_partners: [true, false, false, false, false, false],
      documents: [true, true, true, true, true, false],
    },
  },
  {
    name: 'Marketing',
    description: 'Runs outreach and analyses lead sources.',
    capabilities: ['records.export', 'records.import', 'ai.use', 'whatsapp.send', 'whatsapp.templates', 'dashboards.share'],
    modules: {
      leads: [true, true, true, false, true, true],
      contacts: [true, false, false, false, true, false],
      properties: [true, false, false, false, false, false],
      deals: [true, false, false, false, true, false],
      site_visits: [true, false, false, false, false, false],
      documents: [true, true, true, false, false, false],
      organizations: [true, false, false, false, false, false],
      bookings: [true, false, false, false, false, false],
      payments: [false, false, false, false, false, false],
      channel_partners: [true, false, false, false, false, false],
    },
    fieldOverrides: {
      properties: { base_price: 'readonly' },
    },
  },
  {
    name: 'Finance',
    description: 'Collections, receipts and commission payouts.',
    capabilities: ['records.export', 'records.import', 'ai.use'],
    modules: {
      leads: [false, false, false, false, false, false],
      contacts: [true, false, false, false, true, false],
      organizations: [true, false, false, false, true, false],
      properties: [true, false, false, false, true, false],
      deals: [true, false, false, false, true, false],
      site_visits: [false, false, false, false, false, false],
      bookings: [true, false, true, false, true, false],
      payments: [true, true, true, true, true, true],
      channel_partners: [true, false, true, false, true, false],
      documents: [true, true, true, false, true, false],
    },
  },
  {
    name: 'Channel Partner (Portal)',
    description: 'Restricted profile for external brokers — only their own submissions.',
    capabilities: ['ai.use'],
    modules: {
      leads: [true, true, true, false, false, false],
      properties: [true, false, false, false, false, false],
      site_visits: [true, true, false, false, false, false],
      contacts: [false, false, false, false, false, false],
      organizations: [false, false, false, false, false, false],
      deals: [false, false, false, false, false, false],
      bookings: [true, false, false, false, false, false],
      payments: [false, false, false, false, false, false],
      channel_partners: [false, false, false, false, false, false],
      documents: [true, false, false, false, false, false],
    },
    fieldOverrides: {
      properties: { base_price: 'readonly', total_price: 'readonly', rate_per_sqft: 'hidden' },
      leads: { ai_score: 'hidden', ai_score_reasons: 'hidden' },
    },
  },
];

export async function seedProfiles(conn: Tx): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const def of PROFILES) {
    // Create-only. Capabilities are access-control decisions an admin makes in
    // Settings → Profiles; re-seeding them handed back permissions somebody had
    // deliberately removed, and did it on every cold start rather than only on
    // deploy. The per-module and per-field grants below stay DO NOTHING for the
    // same reason — but they still insert, so a module added to the template
    // gets its default grants instead of being invisible to existing profiles.
    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_profile WHERE name = $1`,
      [def.name],
    );
    const profileId = existing?.id ?? (await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_profile (name, description, is_system, capabilities)
       VALUES ($1,$2,true,$3)
       RETURNING id`,
      [def.name, def.description, JSON.stringify(def.capabilities)],
    ))!.id;
    ids.set(def.name, profileId);

    for (const [moduleName, p] of Object.entries(def.modules)) {
      const mod = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [moduleName]);
      if (!mod) continue;
      await conn.query(
        `INSERT INTO ipy_profile_module_perm
           (profile_id, module_id, can_view, can_create, can_edit, can_delete, can_export, can_import)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (profile_id, module_id) DO NOTHING`,
        [profileId, mod.id, ...p],
      );
    }

    for (const [moduleName, fields] of Object.entries(def.fieldOverrides ?? {})) {
      for (const [fieldName, permission] of Object.entries(fields)) {
        const fld = await conn.queryOne<{ id: string }>(
          `SELECT f.id FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
           WHERE m.name = $1 AND f.name = $2`,
          [moduleName, fieldName],
        );
        if (!fld) continue;
        await conn.query(
          `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
           VALUES ($1,$2,$3)
           ON CONFLICT (profile_id, field_id) DO NOTHING`,
          [profileId, fld.id, permission],
        );
      }
    }
  }

  return ids;
}

/**
 * Default org-wide sharing. Leads and Deals are private (reps see their own,
 * managers see down the hierarchy); inventory is public-read so everyone can
 * quote from the same catalogue.
 */
const SHARING_DEFAULTS: Record<string, string> = {
  leads: 'private',
  contacts: 'private',
  organizations: 'public_read',
  properties: 'public_read',
  deals: 'private',
  site_visits: 'private',
  bookings: 'private',
  payments: 'private',
  channel_partners: 'public_read',
  documents: 'private',
};

export async function seedSharing(conn: Tx): Promise<void> {
  for (const [moduleName, access] of Object.entries(SHARING_DEFAULTS)) {
    const mod = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [moduleName]);
    if (!mod) continue;
    await conn.query(
      // Create-only: the org-wide default (private/read/read-write) is an admin
      // decision in Settings → Sharing, not something a redeploy should revert.
      `INSERT INTO ipy_module_sharing (module_id, access) VALUES ($1,$2)
       ON CONFLICT (module_id) DO NOTHING`,
      [mod.id, access],
    );
  }
}

export interface SeededUser {
  id: string;
  email: string;
  name: string;
}

interface UserDef {
  email: string;
  first: string;
  last: string;
  role: string;
  profile: string;
  isAdmin?: boolean;
  phone?: string;
  extension?: string;
  designation?: string;
  /** name of the channel_partners record to link — turns the account into a portal user */
}

export const DEMO_USERS: UserDef[] = [
  { email: 'priya.sharma@ipropy.com', first: 'Priya', last: 'Sharma', role: 'Sales Head', profile: 'Sales Head', phone: '+919820011001', extension: '101', designation: 'National Sales Head' },
  { email: 'rahul.mehta@ipropy.com', first: 'Rahul', last: 'Mehta', role: 'Sales Manager', profile: 'Sales Manager', phone: '+919820011002', extension: '102', designation: 'Sales Manager — West' },
  { email: 'aisha.khan@ipropy.com', first: 'Aisha', last: 'Khan', role: 'Sales Executive', profile: 'Sales Executive', phone: '+919820011003', extension: '103', designation: 'Senior Sales Executive' },
  { email: 'vikram.rao@ipropy.com', first: 'Vikram', last: 'Rao', role: 'Sales Executive', profile: 'Sales Executive', phone: '+919820011004', extension: '104', designation: 'Sales Executive' },
  { email: 'neha.gupta@ipropy.com', first: 'Neha', last: 'Gupta', role: 'Tele-caller', profile: 'Pre-Sales / Tele-caller', phone: '+919820011005', extension: '105', designation: 'Pre-Sales Executive' },
  { email: 'arjun.nair@ipropy.com', first: 'Arjun', last: 'Nair', role: 'CRM Executive', profile: 'CRM / Post-Sales', phone: '+919820011006', extension: '106', designation: 'CRM Executive' },
  { email: 'divya.patel@ipropy.com', first: 'Divya', last: 'Patel', role: 'Marketing Executive', profile: 'Marketing', phone: '+919820011007', extension: '107', designation: 'Marketing Manager' },
  { email: 'sanjay.iyer@ipropy.com', first: 'Sanjay', last: 'Iyer', role: 'Accounts Executive', profile: 'Finance', phone: '+919820011008', extension: '108', designation: 'Accounts Manager' },
  { email: 'kiran.desai@ipropy.com', first: 'Kiran', last: 'Desai', role: 'Channel Partner Manager', profile: 'Sales Manager', phone: '+919820011009', extension: '109', designation: 'Channel Partner Manager' },
  { email: 'rakesh.bhandari@ipropy.com', first: 'Rakesh', last: 'Bhandari', role: 'Channel Partner', profile: 'Channel Partner (Portal)', phone: '+919820011010', designation: 'Partner — Bhandari Realty Advisors' },
  { email: 'sunita.menon@ipropy.com', first: 'Sunita', last: 'Menon', role: 'Channel Partner', profile: 'Channel Partner (Portal)', phone: '+919820011011', designation: 'Partner — Menon Properties' },
];

/**
 * The fixed-id "system" user that unattended lead capture writes as
 * created_by (see integrations/leadsources/capture.ts SYSTEM_USER — id must
 * match exactly). Without a real row here, every unauthenticated capture
 * path (webforms, portal leads, Facebook/Google Ads, IMAP inbound) fails
 * createRecord's created_by FK constraint. Can never log in: no password_hash.
 */
export async function seedSystemUser(conn: Tx): Promise<void> {
  await conn.query(
    `INSERT INTO ipy_user (id, email, first_name, last_name, is_admin, is_active)
     VALUES ('00000000-0000-0000-0000-000000000000', 'system@ipropy', 'iPropy', 'Capture', true, true)
     ON CONFLICT (id) DO NOTHING`,
  );
}

export async function seedUsers(
  conn: Tx,
  roles: Map<string, string>,
  profiles: Map<string, string>,
  includeDemo: boolean,
): Promise<SeededUser[]> {
  const created: SeededUser[] = [];
  const hash = await bcrypt.hash(config.seed.adminPassword, config.auth.bcryptRounds);

  const admin = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_user (email, password_hash, first_name, last_name, is_admin, role_id, profile_id, designation, extension, phone)
     VALUES ($1,$2,'iPropy','Admin',true,$3,$4,'System Administrator','100','+919820011000')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [config.seed.adminEmail, hash, roles.get('CEO'), profiles.get('Administrator')],
  );
  if (admin) {
    created.push({ id: admin.id, email: config.seed.adminEmail, name: 'iPropy Admin' });
  } else {
    const existing = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE lower(email) = lower($1)`, [config.seed.adminEmail]);
    if (existing) created.push({ id: existing.id, email: config.seed.adminEmail, name: 'iPropy Admin' });
  }

  if (!includeDemo) return created;

  for (const u of DEMO_USERS) {
    const row = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_user (email, password_hash, first_name, last_name, role_id, profile_id, phone, extension, designation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [u.email, hash, u.first, u.last, roles.get(u.role), profiles.get(u.profile), u.phone, u.extension, u.designation],
    );
    const id = row?.id
      ?? (await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE lower(email) = lower($1)`, [u.email]))?.id;
    if (id) created.push({ id, email: u.email, name: `${u.first} ${u.last}` });
  }

  return created;
}

export async function seedGroups(conn: Tx, users: SeededUser[]): Promise<void> {
  const groups = [
    { name: 'Inside Sales', description: 'Tele-calling and lead qualification pod', members: ['neha.gupta@ipropy.com', 'aisha.khan@ipropy.com'] },
    { name: 'Field Sales — West', description: 'Mumbai and Pune field team', members: ['rahul.mehta@ipropy.com', 'aisha.khan@ipropy.com', 'vikram.rao@ipropy.com'] },
    { name: 'Post-Sales & Collections', description: 'CRM, documentation and collections', members: ['arjun.nair@ipropy.com', 'sanjay.iyer@ipropy.com'] },
    { name: 'Marketing', description: 'Outreach and demand generation team', members: ['divya.patel@ipropy.com'] },
  ];

  for (const g of groups) {
    const found = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_group WHERE name = $1`, [g.name]);
    const row = found ?? await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_group (name, description) VALUES ($1,$2) RETURNING id`,
      [g.name, g.description],
    );
    if (!row) continue;
    for (const email of g.members) {
      const user = users.find((u) => u.email === email);
      if (!user) continue;
      await conn.query(
        `INSERT INTO ipy_group_member (group_id, member_type, member_id) VALUES ($1,'user',$2)
         ON CONFLICT DO NOTHING`,
        [row.id, user.id],
      );
    }
  }
}
