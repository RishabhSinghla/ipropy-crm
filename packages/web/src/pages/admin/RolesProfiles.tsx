import { type JSX, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Eye, EyeOff, Lock, Plus, Save, Search, Shield, UserCheck, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { byLabel } from '../../lib/fields';
import { cn } from '../../lib/utils';
import { Modal, Select, Skeleton, Spinner } from '../../components/ui';

/**
 * One page, one thing: the Role.
 *
 * A role used to come with a second choice called a Profile, which was only
 * ever "what this role may do" — two dropdowns for one decision, and nothing
 * stopping them disagreeing (a Sales Executive holding an Administrator
 * profile was one misclick away). They are merged: every role owns its
 * permissions, the hierarchy on the left decides whose records a user sees,
 * and the panels on the right decide what the role's people can do.
 */
interface RoleNode {
  id: string; name: string; parent_id: string | null; depth: number;
  description: string | null; user_count: number; profile_id?: string | null; children: RoleNode[];
}

type Perm = { view: boolean; create: boolean; edit: boolean; delete: boolean; export: boolean; import: boolean };
type FieldPermValue = 'editable' | 'readonly' | 'owner_only' | 'hidden';

export default function RolesProfiles(): JSX.Element {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['roles'], queryFn: () => api.roles() });

  const tree = (data?.tree ?? []) as unknown as RoleNode[];
  const flat = (data?.flat ?? []) as unknown as RoleNode[];

  /** The selected role — the first root while nothing is picked. */
  const active = flat.find((r) => r.id === (selectedId ?? tree[0]?.id)) ?? null;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Roles</h1>
          <p className="text-sm text-muted">
            One role is both the reporting line and what it may do — pick a role on the left,
            set its permissions on the right.
          </p>
        </div>
        <button onClick={() => setCreating(true)} className="btn-primary btn-sm">
          <Plus className="h-3.5 w-3.5" /> New role
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="card h-fit overflow-hidden">
          <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <p className="text-xs font-medium text-muted">Hierarchy</p>
          </div>
          {isLoading ? (
            <div className="space-y-1 p-1.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : (
            <div className="p-1.5">
              {tree.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  activeId={active?.id ?? null}
                  onSelect={(id) => setSelectedId(id)}
                />
              ))}
              <p className="mt-3 border-t border-slate-100 px-2 pt-2 text-2xs text-muted dark:border-slate-800">
                A user sees records owned by themselves and by everyone below them here.
              </p>
            </div>
          )}
        </div>

        {active ? (
          <RolePermissions key={active.id} role={active} />
        ) : (
          <div className="card flex items-center justify-center p-10 text-sm text-muted">
            {isLoading ? <Spinner /> : 'No roles yet — create the first one.'}
          </div>
        )}
      </div>

      {creating && (
        <RoleCreator
          roles={flat}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['roles'] });
          }}
        />
      )}
    </div>
  );
}

function RoleRow({
  role, activeId, onSelect,
}: { role: RoleNode; activeId: string | null; onSelect: (id: string) => void }): JSX.Element {
  const selected = activeId === role.id;
  return (
    <>
      <button
        onClick={() => onSelect(role.id)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
          selected ? 'bg-brand-50 dark:bg-brand-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
        )}
        style={{ paddingLeft: `${role.depth * 1.25 + 0.5}rem` }}
      >
        {role.depth > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-slate-300" />}
        <Shield className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-brand-600 dark:text-brand-400' : 'text-slate-400')} />
        <span className={cn('truncate text-sm', selected && 'font-medium text-brand-700 dark:text-brand-300')}>{role.name}</span>
        {role.user_count > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-slate-100 px-1.5 text-2xs text-muted tnum dark:bg-slate-800">
            {role.user_count}
          </span>
        )}
      </button>
      {role.children?.map((child) => (
        <RoleRow key={child.id} role={child} activeId={activeId} onSelect={onSelect} />
      ))}
    </>
  );
}

function RoleCreator({
  roles, onClose, onCreated,
}: { roles: RoleNode[]; onClose: () => void; onCreated: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title="New role"
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!name || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.createRole({ name, parentId: parentId || null });
                toast.success('Role created', 'It starts with the permissions of the role it reports to.');
                onCreated();
              } catch (err) {
                toast.error('Could not create the role', (err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />} Create role
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Role name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="label">Reports to</label>
          <Select
            value={parentId}
            onChange={setParentId}
            placeholder="— Top level —"
            options={roles.map((r) => ({ value: r.id, label: `${'· '.repeat(r.depth)}${r.name}` }))}
          />
          <p className="mt-1 text-2xs text-muted">
            The new role starts with a copy of that role's permissions — change them right after creating it.
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/**
 * Plain-language names for the capability keys. Without this the admin is
 * staring at raw strings like `records.transfer_ownership` and has no way to
 * know that is the switch behind the Reassign button on list views — which is
 * exactly the permission a Sales Manager needs and the one most often
 * reported "missing".
 */
const CAPABILITY_INFO: Record<string, { label: string; hint: string }> = {
  'records.transfer_ownership': {
    label: 'Reassign records (change owner)',
    hint: 'Lets the role use the "Reassign" button on list views to hand records to another user.',
  },
  'records.mass_edit': { label: 'Bulk edit records', hint: 'Edit a field across many selected records at once.' },
  'records.mass_delete': { label: 'Bulk delete records', hint: 'Delete many selected records at once.' },
  'records.export': { label: 'Export records', hint: 'Download records to a file.' },
  'records.import': { label: 'Import records', hint: 'Bring records in from a file.' },
  'records.view_all': { label: 'See all records', hint: 'See every record regardless of owner and role hierarchy.' },
  'dashboards.share': { label: 'Share dashboards', hint: 'Publish dashboards to other users.' },
  'ai.use': { label: 'Use AI features', hint: 'AI suggestions and summaries inside the CRM.' },
  'ai.configure': { label: 'Configure AI', hint: 'Set up AI behaviour and prompts.' },
  'telephony.call': { label: 'Click-to-call', hint: 'Place calls from the CRM.' },
  'telephony.listen_recordings': { label: 'Listen to call recordings', hint: 'Play back recorded calls.' },
  'whatsapp.send': { label: 'Send WhatsApp messages', hint: 'Message contacts over WhatsApp.' },
  'whatsapp.templates': { label: 'Manage WhatsApp templates', hint: 'Create and edit message templates.' },
  'inventory.block_unit': { label: 'Block inventory units', hint: 'Hold a property unit for a customer.' },
  'inventory.change_price': { label: 'Change inventory prices', hint: 'Edit the price of a property unit.' },
  'bookings.approve_discount': { label: 'Approve booking discounts', hint: 'Sign off discounts on bookings.' },
  'admin.access': { label: 'Admin access', hint: 'Enter the admin area at all.' },
  'admin.users': { label: 'Manage users', hint: 'Invite, deactivate and edit users.' },
  'admin.roles': { label: 'Manage roles', hint: 'Create roles and set their permissions.' },
  'admin.profiles': { label: 'Manage permission sets', hint: 'Edit the permission sets behind roles.' },
  'admin.modules': { label: 'Manage modules', hint: 'Create and reshape modules.' },
  'admin.fields': { label: 'Manage fields', hint: 'Add fields and change their types.' },
  'admin.layouts': { label: 'Manage layouts', hint: 'Rearrange forms and detail pages.' },
  'admin.picklists': { label: 'Manage picklists', hint: 'Edit dropdown options.' },
  'admin.sharing': { label: 'Manage sharing rules', hint: 'Write rules that open records across roles.' },
  'admin.workflows': { label: 'Manage workflows', hint: 'Build automation rules.' },
  'admin.integrations': { label: 'Manage integrations', hint: 'Connect outside services.' },
  'admin.templates': { label: 'Manage templates', hint: 'Edit document and email templates.' },
  'admin.numbering': { label: 'Manage numbering', hint: 'Set auto-number formats for records.' },
  'admin.audit': { label: 'View audit log', hint: 'See who changed what.' },
};

/**
 * Capabilities in groups, because thirty-five checkboxes in one grid is a
 * wall.
 *
 * They were one flat list ordered by a hand-written array of seven with
 * everything else trailing alphabetically, which put "Manage numbering" next
 * to "Send WhatsApp messages" and left an administrator scanning all of them
 * to find the one they came for. The prefixes were already the grouping —
 * `records.`, `admin.`, `whatsapp.` — this just says so out loud.
 *
 * "Setting up the CRM" starts shut. It is two thirds of the list, it is the
 * part a sales head never touches, and closed it takes one line instead of
 * twenty-four.
 */
const CAP_GROUPS: { id: string; title: string; blurb: string; caps: string[]; closed?: boolean }[] = [
  {
    id: 'records',
    title: 'Working with records',
    blurb: 'What this role may do to leads and inventory beyond plain view, create, edit and delete.',
    caps: [
      'records.transfer_ownership', 'records.mass_edit', 'records.mass_delete',
      'records.export', 'records.import', 'records.view_all',
    ],
  },
  {
    id: 'contact',
    title: 'Reaching customers',
    blurb: 'Calling, messaging, and what the role may hear afterwards.',
    caps: ['telephony.call', 'telephony.listen_recordings', 'whatsapp.send', 'whatsapp.templates'],
  },
  {
    id: 'deals',
    title: 'Inventory and deals',
    blurb: 'Holding a unit, changing its price, signing off a discount.',
    caps: ['inventory.block_unit', 'inventory.change_price', 'bookings.approve_discount'],
  },
  {
    id: 'ai',
    title: 'AI and dashboards',
    blurb: '',
    caps: ['ai.use', 'ai.configure', 'dashboards.share'],
  },
  {
    id: 'admin',
    title: 'Setting up the CRM',
    blurb: 'The admin area and everything in it. Most roles need none of these.',
    closed: true,
    caps: [
      'admin.access', 'admin.users', 'admin.roles', 'admin.profiles', 'admin.modules',
      'admin.fields', 'admin.layouts', 'admin.picklists', 'admin.sharing', 'admin.workflows',
      'admin.integrations', 'admin.templates', 'admin.numbering', 'admin.audit',
    ],
  },
];

/**
 * What one role may do. Everything edits the role's own linked profile — the
 * admin never sees the word "profile", because to them the role *is* its
 * permissions now.
 */
function RolePermissions({ role }: { role: RoleNode }): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [perms, setPerms] = useState<Record<string, Perm>>({});
  const [capabilities, setCapabilities] = useState<string[]>([]);
  /** Which capability groups are open. Unset means the group's own default. */
  const [openCapGroups, setOpenCapGroups] = useState<Record<string, boolean>>({});
  const [fieldQuery, setFieldQuery] = useState('');
  const [fieldPerms, setFieldPerms] = useState<Map<string, FieldPermValue>>(new Map());
  const [fieldModule, setFieldModule] = useState('leads');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const profileId = role.profile_id ?? null;
  const { data: detail } = useQuery({
    queryKey: ['profile', profileId],
    queryFn: () => api.profile(profileId!),
    enabled: Boolean(profileId),
  });

  const { data: fieldModuleMeta } = useQuery({
    queryKey: ['module', fieldModule],
    queryFn: () => api.module(fieldModule),
    enabled: Boolean(fieldModule),
  });

  /*
    The fields this panel is showing: alphabetical, de-duplicated, and narrowed
    by the search box.

    Alphabetical because they arrive in `sequence` — the order somebody
    arranged the *form* in — and this is a list you scan for one name.

    De-duplicated by column because the assignment field appears twice on this
    business's Leads: once as `assigned_to` and once as the record's own
    `owner_id`, both labelled "Assigned To", both the same column. Two
    identical rows with independent settings is a trap — whichever one you set,
    the other still applies.
  */
  const visibleFields = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    const seen = new Set<string>();
    return byLabel((fieldModuleMeta?.fields ?? []).filter((f) => f.isActive))
      .filter((f) => {
        const column = f.columnName ?? f.name;
        if (seen.has(column)) return false;
        seen.add(column);
        return true;
      })
      .filter((f) => !q || f.label.toLowerCase().includes(q) || f.name.toLowerCase().includes(q));
  }, [fieldModuleMeta, fieldQuery]);

  useEffect(() => {
    if (!detail) return;
    setPerms((detail.modulePermissions ?? {}) as Record<string, Perm>);
    setCapabilities((detail.capabilities ?? []) as string[]);
    const fp = (detail.fieldPermissions ?? []) as { module: string; field: string; permission: FieldPermValue }[];
    setFieldPerms(new Map(fp.map((f) => [`${f.module}::${f.field}`, f.permission])));
    setDirty(false);
  }, [detail]);

  const allCapabilities = (detail?.availableCapabilities ?? []) as string[];

  const toggle = (moduleName: string, action: keyof Perm): void => {
    setPerms((prev) => {
      const current = prev[moduleName] ?? { view: false, create: false, edit: false, delete: false, export: false, import: false };
      const next = { ...current, [action]: !current[action] };
      // Every other permission is meaningless without view.
      if (action === 'view' && !next.view) {
        next.create = false; next.edit = false; next.delete = false; next.export = false; next.import = false;
      }
      if (action !== 'view' && next[action]) next.view = true;
      return { ...prev, [moduleName]: next };
    });
    setDirty(true);
  };

  const setFieldPerm = (moduleName: string, fieldName: string, permission: FieldPermValue): void => {
    setFieldPerms((prev) => new Map(prev).set(`${moduleName}::${fieldName}`, permission));
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!profileId) return;
    setSaving(true);
    try {
      const fieldPermissions = [...fieldPerms.entries()].map(([key, permission]) => {
        const [module, field] = key.split('::');
        return { module, field, permission };
      });
      await api.saveProfilePermissions(profileId, { modulePermissions: perms, capabilities, fieldPermissions });
      toast.success(`${role.name} permissions saved`);
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['profile', profileId] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const ACTIONS: (keyof Perm)[] = ['view', 'create', 'edit', 'delete', 'export', 'import'];

  if (!profileId) {
    return (
      <div className="card flex items-center justify-center p-10 text-sm text-muted">
        This role has no permission set attached. Re-create it or pick a different role.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <Users className="h-4 w-4 text-slate-400" />
          <p className="text-sm font-medium">Module permissions — {role.name}</p>
          <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm ml-auto">
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="list-head">Module</th>
                {ACTIONS.map((a) => <th key={a} className="list-head text-center capitalize">{a}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {modules.filter((m) => m.isEntity).map((m) => {
                const p = perms[m.name] ?? { view: false, create: false, edit: false, delete: false, export: false, import: false };
                return (
                  <tr key={m.name} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <td className="list-cell font-medium">{m.label}</td>
                    {ACTIONS.map((action) => (
                      <td key={action} className="list-cell text-center">
                        <button
                          onClick={() => toggle(m.name, action)}
                          aria-label={`${action} ${m.label}`}
                          className={cn(
                            'inline-flex h-5 w-5 items-center justify-center rounded border transition-colors',
                            p[action]
                              ? 'border-brand-600 bg-brand-600 text-white'
                              : 'border-slate-300 hover:border-slate-400 dark:border-slate-600',
                          )}
                        >
                          {p[action] && <Check className="h-3 w-3" />}
                        </button>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <p className="text-sm font-medium">Field permissions</p>
          <span className="text-2xs text-muted">
            — what this role sees and can edit, field by field
          </span>
          <div className="ml-auto w-56">
            <Select
              value={fieldModule}
              onChange={setFieldModule}
              options={modules.filter((m) => m.isEntity).map((m) => ({ value: m.name, label: m.label }))}
            />
          </div>
          <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm">
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
        </div>

        {/*
          A search and a bulk set, because this list is as long as the module.

          Twenty-four fields times four buttons is ninety-six controls in one
          scroll box, and the job somebody actually comes here for is usually
          one field ("hide the mobile from telecallers") or all of them ("this
          role reads everything and changes nothing"). Neither was reachable
          without scrolling through the other ninety.
        */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className="input py-1.5 pl-8 text-xs"
              placeholder="Find a field…"
              value={fieldQuery}
              onChange={(e) => setFieldQuery(e.target.value)}
              aria-label="Find a field"
            />
          </div>
          <span className="text-2xs text-muted">Set all shown to</span>
          {([
            ['editable', 'Editable'], ['readonly', 'Read-only'],
            ['owner_only', 'Owner only'], ['hidden', 'Hidden'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="btn-secondary btn-sm text-2xs"
              onClick={() => visibleFields.forEach((f) => setFieldPerm(fieldModule, f.name, value))}
            >
              {label}
            </button>
          ))}
        </div>

        {!fieldModuleMeta ? (
          <div className="space-y-2 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : (
          <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {visibleFields.map((f) => {
              const key = `${fieldModule}::${f.name}`;
              const value = fieldPerms.get(key) ?? 'editable';
              return (
                <div key={f.name} className="flex items-center gap-3 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{f.label}</p>
                    <p className="font-mono text-2xs text-muted">{f.name}</p>
                  </div>
                  <div className="flex shrink-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                    {([
                      { value: 'editable' as const, label: 'Editable', icon: Eye,
                        hint: 'Read and change it.' },
                      { value: 'readonly' as const, label: 'Read-only', icon: Lock,
                        hint: 'See the value; cannot change it.' },
                      // The record-aware one. Named for what it does rather
                      // than for the mechanism ("masked"), because the choice
                      // being made here is about who, not about asterisks.
                      { value: 'owner_only' as const, label: 'Owner only', icon: UserCheck,
                        hint: 'Only the person the record is assigned to sees the real value. '
                          + 'Everyone else gets 98xxxxxx56 and can reveal one number at a time, '
                          + 'which is written to the audit log.' },
                      { value: 'hidden' as const, label: 'Hidden', icon: EyeOff,
                        hint: 'Not sent to this role at all.' },
                    ]).map((opt, i) => (
                      <button
                        key={opt.value}
                        onClick={() => setFieldPerm(fieldModule, f.name, opt.value)}
                        title={`${opt.label} — ${opt.hint}`}
                        aria-label={`${f.label}: ${opt.label}`}
                        className={cn(
                          'flex items-center gap-1 px-2 py-1 text-2xs transition-colors',
                          i > 0 && 'border-l border-slate-200 dark:border-slate-700',
                          value === opt.value
                            ? 'bg-brand-600 text-white'
                            : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800',
                        )}
                      >
                        <opt.icon className="h-3 w-3" /> {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {visibleFields.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-muted">
                {fieldQuery ? `No field mentions “${fieldQuery}”.` : 'No fields on this module.'}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="card p-4">
        <p className="mb-1 text-sm font-medium">Capabilities — extra powers beyond module access</p>
        <p className="mb-3 text-2xs text-muted">
          These are on/off switches for whole features. &ldquo;Reassign records&rdquo; is the one behind the
          Reassign button on list pages such as Leads — without it, that button fails even when the
          role can edit the records.
        </p>
        {/*
          Anything the server offers that no group above claims still has to
          appear, or a capability added later would be invisible here and
          ungrantable — the same trap the settings page avoids by rendering
          whatever is in its table.
        */}
        <div className="space-y-2">
          {[
            ...CAP_GROUPS.map((g) => ({ ...g, caps: g.caps.filter((c) => allCapabilities.includes(c)) })),
            {
              id: 'other',
              title: 'Everything else',
              blurb: 'Added to the CRM since this screen was written.',
              closed: false,
              caps: allCapabilities.filter((c) => !CAP_GROUPS.some((g) => g.caps.includes(c))).slice().sort(),
            },
          ]
            .filter((group) => group.caps.length > 0)
            .map((group) => {
              const on = group.caps.filter((c) => capabilities.includes(c)).length;
              const open = openCapGroups[group.id] ?? !group.closed;
              return (
                <div key={group.id} className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenCapGroups((cur) => ({ ...cur, [group.id]: !open }))}
                    className="flex w-full items-center gap-2 bg-slate-50 px-3 py-2 text-left dark:bg-slate-800/50"
                  >
                    <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} />
                    <span className="text-sm font-medium">{group.title}</span>
                    <span className="text-2xs text-muted tnum">{on} of {group.caps.length} on</span>
                  </button>
                  {open && (
                    <>
                      {group.blurb && <p className="px-3 pt-2 text-2xs text-muted">{group.blurb}</p>}
                      <div className="grid gap-1.5 p-3 sm:grid-cols-2 lg:grid-cols-3">
                        {group.caps.map((cap) => {
                          const active = capabilities.includes(cap);
                          const info = CAPABILITY_INFO[cap] ?? { label: cap, hint: '' };
                          return (
                            <label
                              key={cap}
                              /* The internal key lives in the tooltip now, not on
                                 the face of every card. It matters when somebody is
                                 reading the API docs and is noise the other
                                 ninety-nine times — and thirty-five lines of
                                 `admin.picklists` is most of what made this panel
                                 read as a wall. */
                              title={`${info.hint}${info.hint ? '\n\n' : ''}${cap}`}
                              className={cn(
                                'flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                                active
                                  ? 'border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-950/50'
                                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
                              )}
                            >
                              <input
                                type="checkbox"
                                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300"
                                checked={active}
                                onChange={() => {
                                  setCapabilities(active ? capabilities.filter((c) => c !== cap) : [...capabilities, cap]);
                                  setDirty(true);
                                }}
                              />
                              <span className="min-w-0">
                                <span className="block font-medium leading-tight">{info.label}</span>
                                {info.hint && <span className="block text-2xs leading-snug text-muted">{info.hint}</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
