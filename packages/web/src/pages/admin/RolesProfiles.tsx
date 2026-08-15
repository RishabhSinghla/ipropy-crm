import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Eye, EyeOff, Lock, Plus, Save, Shield, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Modal, Select, Skeleton, Spinner, Tabs } from '../../components/ui';

interface RoleNode {
  id: string; name: string; parent_id: string | null; depth: number;
  description: string | null; user_count: number; children: RoleNode[];
}

type Perm = { view: boolean; create: boolean; edit: boolean; delete: boolean; export: boolean; import: boolean };
type FieldPermValue = 'editable' | 'readonly' | 'hidden';

export default function RolesProfiles(): JSX.Element {
  const [tab, setTab] = useState('roles');

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Roles & Profiles</h1>
        <p className="text-sm text-muted">
          Roles form the reporting hierarchy and decide <em>whose records</em> a user can see.
          Profiles decide <em>what they can do</em>.
        </p>
      </div>

      <Tabs
        tabs={[
          { key: 'roles', label: 'Role hierarchy', icon: <Users className="h-3.5 w-3.5" /> },
          { key: 'profiles', label: 'Profiles', icon: <Shield className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'roles' ? <RolesTab /> : <ProfilesTab />}
    </div>
  );
}

function RolesTab(): JSX.Element {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['roles'], queryFn: () => api.roles() });

  const tree = (data?.tree ?? []) as unknown as RoleNode[];

  return (
    <>
      <div className="mb-3 flex justify-end">
        <button onClick={() => setCreating(true)} className="btn-primary btn-sm">
          <Plus className="h-3.5 w-3.5" /> New role
        </button>
      </div>

      <div className="card p-4">
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : (
          <div className="space-y-0.5">
            {tree.map((role) => <RoleRow key={role.id} role={role} />)}
          </div>
        )}
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-muted dark:border-slate-800">
          A user sees records owned by themselves and by everyone below them in this tree.
        </p>
      </div>

      {creating && (
        <RoleCreator
          roles={(data?.flat ?? []) as unknown as RoleNode[]}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['roles'] });
          }}
        />
      )}
    </>
  );
}

function RoleRow({ role }: { role: RoleNode }): JSX.Element {
  return (
    <>
      <div
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
        style={{ paddingLeft: `${role.depth * 1.5 + 0.5}rem` }}
      >
        {role.depth > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-slate-300" />}
        <Shield className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="text-sm font-medium">{role.name}</span>
        {role.user_count > 0 && (
          <span className="rounded-full bg-slate-100 px-1.5 text-2xs text-muted tnum dark:bg-slate-800">
            {role.user_count} user{role.user_count === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {role.children?.map((child) => <RoleRow key={child.id} role={child} />)}
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
                toast.success('Role created');
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
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ProfilesTab(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [perms, setPerms] = useState<Record<string, Perm>>({});
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [fieldPerms, setFieldPerms] = useState<Map<string, FieldPermValue>>(new Map());
  const [fieldModule, setFieldModule] = useState('leads');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: profiles, isLoading } = useQuery({ queryKey: ['profiles'], queryFn: () => api.profiles() });
  const list = (profiles ?? []) as unknown as { id: string; name: string; description: string; is_system: boolean; user_count: number }[];

  const activeId = selectedId ?? list[0]?.id;

  const { data: detail } = useQuery({
    queryKey: ['profile', activeId],
    queryFn: () => api.profile(activeId!),
    enabled: Boolean(activeId),
  });

  const { data: fieldModuleMeta } = useQuery({
    queryKey: ['module', fieldModule],
    queryFn: () => api.module(fieldModule),
    enabled: Boolean(fieldModule),
  });

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
    if (!activeId) return;
    setSaving(true);
    try {
      const fieldPermissions = [...fieldPerms.entries()].map(([key, permission]) => {
        const [module, field] = key.split('::');
        return { module, field, permission };
      });
      await api.saveProfilePermissions(activeId, { modulePermissions: perms, capabilities, fieldPermissions });
      toast.success('Permissions saved');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['profile', activeId] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const ACTIONS: (keyof Perm)[] = ['view', 'create', 'edit', 'delete', 'export', 'import'];

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="card h-fit overflow-hidden">
        <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
          <p className="text-xs font-medium text-muted">Profiles</p>
        </div>
        <div className="p-1.5">
          {isLoading ? (
            <div className="space-y-1">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : list.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={cn(
                'w-full rounded-lg px-2.5 py-1.5 text-left transition-colors',
                activeId === p.id
                  ? 'bg-brand-50 dark:bg-brand-950'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn('truncate text-sm', activeId === p.id && 'font-medium text-brand-700 dark:text-brand-300')}>
                  {p.name}
                </span>
                <span className="shrink-0 text-2xs text-muted tnum">{p.user_count}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Module permissions</p>
            <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm ml-auto">
              {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-head">Module</th>
                  {ACTIONS.map((a) => <th key={a} className="table-head text-center capitalize">{a}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {modules.filter((m) => m.isEntity).map((m) => {
                  const p = perms[m.name] ?? { view: false, create: false, edit: false, delete: false, export: false, import: false };
                  return (
                    <tr key={m.name} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                      <td className="table-cell font-medium">{m.label}</td>
                      {ACTIONS.map((action) => (
                        <td key={action} className="table-cell text-center">
                          <button
                            onClick={() => toggle(m.name, action)}
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
              — controls what this profile sees and can edit, field by field
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

          {!fieldModuleMeta ? (
            <div className="space-y-2 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : (
            <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {fieldModuleMeta.fields.filter((f) => f.isActive).map((f) => {
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
                        { value: 'editable' as const, label: 'Editable', icon: Eye },
                        { value: 'readonly' as const, label: 'Read-only', icon: Lock },
                        { value: 'hidden' as const, label: 'Hidden', icon: EyeOff },
                      ]).map((opt, i) => (
                        <button
                          key={opt.value}
                          onClick={() => setFieldPerm(fieldModule, f.name, opt.value)}
                          title={opt.label}
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
              {fieldModuleMeta.fields.filter((f) => f.isActive).length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-muted">No fields on this module.</p>
              )}
            </div>
          )}
        </div>

        <div className="card p-4">
          <p className="mb-3 text-sm font-medium">Capabilities</p>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {allCapabilities.map((cap) => {
              const active = capabilities.includes(cap);
              return (
                <label
                  key={cap}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                    active
                      ? 'border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-950/50'
                      : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300"
                    checked={active}
                    onChange={() => {
                      setCapabilities(active ? capabilities.filter((c) => c !== cap) : [...capabilities, cap]);
                      setDirty(true);
                    }}
                  />
                  <span className="truncate font-mono">{cap}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
