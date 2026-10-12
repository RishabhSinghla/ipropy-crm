import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Spinner } from '../../components/ui';

type MasterValue = { value: string; label: string; sortOrder: number; isActive: boolean };
type Masters = Record<string, MasterValue[]>;

const GROUPS = [
  { title: 'Project identity', items: [
    ['category', 'Project category'], ['project_type', 'Project type'], ['project_status', 'Project status'], ['developer', 'Developer / builder'],
  ] },
  { title: 'Location', items: [
    ['state', 'State'], ['city', 'City'], ['locality', 'Sector / locality'],
  ] },
  { title: 'Project details', items: [
    ['area_unit', 'Area units'], ['accommodation', 'Accommodation'], ['facing', 'Facing'], ['furnishing', 'Furnishing'],
    ['amenities', 'Amenities'], ['approvals', 'Approvals'], ['possession', 'Possession'],
  ] },
] as const;

export default function ProjectMastersAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const masters = useQuery({
    queryKey: ['project-workspace', 'masters'],
    queryFn: () => api.request<Masters>('/api/project-workspace/masters'),
  });
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: ({ key, values }: { key: string; values: string[] }) => api.request<{ ok: boolean; count: number }>(
      `/api/project-workspace/masters/${key}`, { method: 'PUT', body: { values } },
    ),
    onSuccess: async (_result, { key }) => {
      setPending((old) => { const copy = { ...old }; delete copy[key]; return copy; });
      await queryClient.invalidateQueries({ queryKey: ['project-workspace', 'masters'] });
      toast.success('Project dropdown saved');
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not save this dropdown'),
  });

  const listFor = (key: string): string[] => pending[key] ?? (masters.data?.[key] ?? []).filter((item) => item.isActive).map((item) => item.label);
  const edit = (key: string, labels: string[]): void => setPending((old) => ({ ...old, [key]: labels }));
  const add = (key: string): void => {
    const next = (drafts[key] ?? '').trim();
    if (!next || listFor(key).some((label) => label.toLocaleLowerCase() === next.toLocaleLowerCase())) return;
    edit(key, [...listFor(key), next]);
    setDrafts((old) => ({ ...old, [key]: '' }));
  };

  if (masters.isLoading) return <div className="flex min-h-64 items-center justify-center"><Spinner className="h-5 w-5 text-brand-600" /></div>;
  if (masters.isError) return <div className="p-6 text-sm text-red-600">{masters.error.message}</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-5 sm:p-8">
      <header className="flex items-start gap-3">
        <div className="rounded-xl bg-brand-50 p-3 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"><Building2 className="h-5 w-5" /></div>
        <div>
          <h1 className="text-xl font-semibold">Project Masters</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">Manage dropdowns used only by Projects. These lists are separate from Leads, Associates and Inventory dropdowns.</p>
        </div>
      </header>
      {GROUPS.map((group) => (
        <section key={group.title} className="overflow-hidden rounded-2xl border border-[var(--border)] bg-white dark:bg-slate-900">
          <h2 className="border-b border-[var(--border)] px-5 py-3 text-sm font-semibold">{group.title}</h2>
          <div className="grid gap-0 md:grid-cols-2">
            {group.items.map(([key, label]) => {
              const values = listFor(key);
              const isDirty = key in pending;
              return (
                <div key={key} className="border-b border-[var(--border)] p-4 md:odd:border-r">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{label}</h3>
                    {isDirty && <button type="button" onClick={() => save.mutate({ key, values })} disabled={save.isPending} className="btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"><Check className="h-3.5 w-3.5" /> Save</button>}
                  </div>
                  <div className="mb-2 flex min-h-9 flex-wrap gap-1.5">
                    {values.map((value) => (
                      <span key={value} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        {value}<button type="button" aria-label={`Remove ${value}`} onClick={() => edit(key, values.filter((item) => item !== value))} className="rounded-full p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700"><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                    {values.length === 0 && <span className="py-1 text-xs text-muted">No values yet</span>}
                  </div>
                  <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); add(key); }}>
                    <input value={drafts[key] ?? ''} onChange={(event) => setDrafts((old) => ({ ...old, [key]: event.target.value }))} className="form-input min-w-0 flex-1" placeholder={`Add ${label.toLocaleLowerCase()}`} />
                    <button type="submit" className={cn('btn-secondary inline-flex shrink-0 items-center gap-1.5 px-3')}><Plus className="h-3.5 w-3.5" /> Add</button>
                  </form>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <p className="text-xs text-muted">Removed options are deactivated, not erased, so older project records retain their original values.</p>
    </div>
  );
}
