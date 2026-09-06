import { type JSX, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { KeyRound, Plus, UserCog } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { Avatar, Badge, Modal, Select, Skeleton, Spinner, Toggle } from '../../components/ui';
import {} from '../../components/FieldRenderer';

interface User {
  id: string; email: string; firstName: string; lastName: string; fullName: string;
  phone: string | null; designation: string | null; isAdmin: boolean; isActive: boolean;
  roleId: string | null; roleName: string | null; profileId: string | null; profileName: string | null;
  lastLoginAt: string | null; acceptsLeads: boolean; dailyLeadCap: number | null;
}

export default function UsersAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<User | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const { data: users, isLoading } = useQuery({
    queryKey: ['users', showInactive],
    queryFn: () => api.users(showInactive),
  });

  const list = (users ?? []) as unknown as User[];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted">
            A user's role controls which records they see; their profile controls what they can do.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Toggle checked={showInactive} onChange={setShowInactive} label="Show inactive" />
          <button onClick={() => setCreating(true)} className="btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" /> New user
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                {['User', 'Role', 'Profile', 'Extension', 'Last login', ''].map((h) => (
                  <th key={h} className="list-head">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <td className="list-cell">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.fullName} size={30} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{u.fullName}</span>
                          {u.isAdmin && <Badge color="#6366f1">Admin</Badge>}
                          {!u.isActive && <Badge color="#94a3b8">Inactive</Badge>}
                        </div>
                        <p className="truncate text-2xs text-muted">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="list-cell text-slate-600 dark:text-slate-400">{u.roleName ?? '—'}</td>
                  <td className="list-cell">{u.profileName ? <Badge>{u.profileName}</Badge> : '—'}</td>
                  <td className="list-cell text-2xs text-muted">
                    {u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}
                  </td>
                  <td className="list-cell">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(u)} className="btn-ghost p-1.5" title="Edit">
                        <UserCog className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setResetting(u)} className="btn-ghost p-1.5" title="Reset password">
                        <KeyRound className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(creating || editing) && (
        <UserEditor
          user={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}

      {resetting && (
        <PasswordReset user={resetting} onClose={() => setResetting(null)} />
      )}
    </div>
  );
}

function UserEditor({
  user, onClose, onSaved,
}: { user: User | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const isEdit = Boolean(user);
  const [form, setForm] = useState({
    email: user?.email ?? '',
    password: '',
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    phone: user?.phone ?? '',
    designation: user?.designation ?? '',
    roleId: user?.roleId ?? '',
    profileId: user?.profileId ?? '',
    isAdmin: user?.isAdmin ?? false,
    isActive: user?.isActive ?? true,
    acceptsLeads: user?.acceptsLeads ?? true,
    dailyLeadCap: user?.dailyLeadCap ?? null as number | null,
  });
  const [saving, setSaving] = useState(false);

  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => api.roles() });
  const { data: profiles } = useQuery({ queryKey: ['profiles'], queryFn: () => api.profiles() });

  const set = (patch: Partial<typeof form>): void => setForm((f) => ({ ...f, ...patch }));

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const payload = {
        email: form.email, firstName: form.firstName, lastName: form.lastName,
        phone: form.phone || undefined, designation: form.designation || undefined,
        roleId: form.roleId || null, profileId: form.profileId || null,
        isAdmin: form.isAdmin, acceptsLeads: form.acceptsLeads,
        dailyLeadCap: form.dailyLeadCap,
        ...(isEdit ? { isActive: form.isActive } : { password: form.password }),
      };
      if (isEdit) await api.updateUser(user!.id, payload);
      else await api.createUser(payload);
      toast.success(isEdit ? 'User updated' : 'User created');
      onSaved();
    } catch (err) {
      toast.error('Could not save the user', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit ${user!.fullName}` : 'New user'}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => void save()}
            disabled={saving || !form.email || !form.firstName || (!isEdit && form.password.length < 8)}
          >
            {saving && <Spinner />} {isEdit ? 'Save changes' : 'Create user'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">First name</label>
            <input className="input" value={form.firstName} onChange={(e) => set({ firstName: e.target.value })} autoFocus />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="input" value={form.lastName} onChange={(e) => set({ lastName: e.target.value })} />
          </div>
        </div>

        <div>
          <label className="label">Email</label>
          <input type="email" className="input" value={form.email} onChange={(e) => set({ email: e.target.value })} />
        </div>

        {!isEdit && (
          <div>
            <label className="label">Temporary password</label>
            <input
              type="text"
              className="input font-mono"
              value={form.password}
              onChange={(e) => set({ password: e.target.value })}
              placeholder="At least 8 characters"
            />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Role (data visibility)</label>
            <Select
              value={form.roleId}
              onChange={(v) => set({ roleId: v })}
              placeholder="— No role —"
              options={((roles?.flat ?? []) as { id: string; name: string; depth: number }[])
                .map((r) => ({ value: r.id, label: `${'· '.repeat(r.depth)}${r.name}` }))}
            />
          </div>
          <div>
            <label className="label">Profile (permissions)</label>
            <Select
              value={form.profileId}
              onChange={(v) => set({ profileId: v })}
              placeholder="— No profile —"
              options={((profiles ?? []) as { id: string; name: string }[])
                .map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Designation</label>
            <input className="input" value={form.designation} onChange={(e) => set({ designation: e.target.value })} />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input tnum" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </div>
        </div>

        <div className="flex flex-col items-start gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <Toggle checked={form.isAdmin} onChange={(v) => set({ isAdmin: v })} label="Administrator (full access)" />
          <Toggle checked={form.acceptsLeads} onChange={(v) => set({ acceptsLeads: v })} label="Include in lead assignment rotation" />
          {isEdit && <Toggle checked={form.isActive} onChange={(v) => set({ isActive: v })} label="Active" />}
          {form.acceptsLeads && (
            <div className="pt-1">
              <label className="label">Daily lead cap (optional)</label>
              <input
                type="number"
                className="input w-32 tnum"
                value={form.dailyLeadCap ?? ''}
                onChange={(e) => set({ dailyLeadCap: e.target.value ? Number(e.target.value) : null })}
                placeholder="Unlimited"
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PasswordReset({ user, onClose }: { user: User; onClose: () => void }): JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reset password for ${user.fullName}`}
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn-primary"
            disabled={password.length < 8 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.request<unknown>(`/api/admin/users/${user.id}/reset-password`, {
                  method: 'POST', body: { password },
                });
                toast.success('Password reset', 'All of their sessions were signed out.');
                onClose();
              } catch (err) {
                toast.error('Reset failed', (err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />} Reset password
          </button>
        </>
      }
    >
      <label className="label">New password</label>
      <input
        type="text"
        className="input font-mono"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="At least 8 characters"
        autoFocus
      />
      <p className="mt-2 text-xs text-muted">
        Resetting signs the user out of every device. Share the new password securely.
      </p>
    </Modal>
  );
}
