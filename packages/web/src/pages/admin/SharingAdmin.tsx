import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Save, Unlock } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Select, Skeleton, Spinner } from '../../components/ui';

const ACCESS_LEVELS = [
  { value: 'private', label: 'Private', hint: 'Owners and their managers only', color: '#ef4444' },
  { value: 'public_read', label: 'Public Read', hint: 'Everyone can view, owners can edit', color: '#f59e0b' },
  { value: 'public_read_write', label: 'Public Read/Write', hint: 'Everyone can view and edit', color: '#0ea5e9' },
  { value: 'public_read_write_delete', label: 'Public Full', hint: 'Everyone can view, edit and delete', color: '#22c55e' },
];

export default function SharingAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['sharing'], queryFn: () => api.sharing() });

  useEffect(() => {
    if (!data) return;
    setDefaults(Object.fromEntries(
      (data.defaults as { module: string; access: string }[]).map((d) => [d.module, d.access]),
    ));
    setDirty(false);
  }, [data]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSharingDefaults(defaults);
      toast.success('Sharing rules saved', 'Data visibility updates immediately.');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['sharing'] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const modules = (data?.defaults ?? []) as unknown as { module: string; label: string; access: string }[];
  const rules = (data?.rules ?? []) as unknown as { id: string; module: string; name: string; access: string }[];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Data Sharing</h1>
          <p className="text-sm text-muted">
            The organisation-wide default for each module. Roles widen this upward;
            sharing rules open specific gaps sideways.
          </p>
        </div>
        <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm ml-auto">
          {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
        </button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-head">Module</th>
                <th className="table-head">Default access</th>
                <th className="table-head">What it means</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {modules.map((m) => {
                const access = defaults[m.module] ?? 'private';
                const level = ACCESS_LEVELS.find((l) => l.value === access);
                return (
                  <tr key={m.module} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <td className="table-cell">
                      <div className="flex items-center gap-2">
                        {access === 'private'
                          ? <Lock className="h-3.5 w-3.5 text-slate-400" />
                          : <Unlock className="h-3.5 w-3.5 text-slate-400" />}
                        <span className="font-medium">{m.label}</span>
                      </div>
                    </td>
                    <td className="table-cell">
                      <Select
                        value={access}
                        onChange={(v) => { setDefaults({ ...defaults, [m.module]: v }); setDirty(true); }}
                        options={ACCESS_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
                        className="w-52 py-1.5 text-sm"
                      />
                    </td>
                    <td className="table-cell">
                      <span className="text-xs text-muted">{level?.hint}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {rules.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Sharing rules</p>
            <p className="text-xs text-muted">
              Grant one team access to another's records without changing the org-wide default.
            </p>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="text-sm">{r.name}</span>
                <Badge className="ml-auto">{r.module}</Badge>
                <Badge color={r.access === 'read_write' ? '#0ea5e9' : '#94a3b8'}>
                  {r.access.replace('_', '/')}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs dark:border-slate-800 dark:bg-slate-900 text-muted">
        <p className="mb-1.5 font-medium text-slate-700 dark:text-slate-300">How access is decided</p>
        <ol className="list-inside list-decimal space-y-1">
          <li>The user's <strong>profile</strong> must allow the action on the module at all.</li>
          <li>The <strong>org-wide default</strong> above applies to everyone.</li>
          <li><strong>Role hierarchy</strong> — managers automatically see their reports' records.</li>
          <li><strong>Sharing rules</strong> grant extra access between roles, teams or individuals.</li>
          <li><strong>Per-record shares</strong> let a user hand one record to a colleague.</li>
        </ol>
      </div>
    </div>
  );
}
