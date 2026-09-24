import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, RotateCcw, Save } from 'lucide-react';
import type { FieldMeta } from '@ipropy/shared';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Select, Skeleton, Spinner } from '../../components/ui';

/**
 * One table view for the whole team.
 *
 * Every person used to arrange their own columns, and every saved list carried
 * a set of its own on top — so "the third column" meant three different things
 * to three people, and the same list looked different to each of them. This is
 * the single answer: what is set here is what everybody sees, on every list of
 * that module, and the per-person controls are gone.
 *
 * The field list is read from the module, never from a list in this file, so a
 * field an admin adds this morning is offerable this afternoon with no deploy.
 */
export default function TableViewAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { data: modules, isLoading } = useQuery({ queryKey: ['modules'], queryFn: () => api.modules() });
  const { data: settings } = useQuery({ queryKey: ['settings', 'ui'], queryFn: () => api.settings('ui') });

  const [module, setModule] = useState<string>('');
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const entityModules = (modules ?? []).filter((m) => m.isEntity && m.showInMenu);
  useEffect(() => {
    if (!module && entityModules.length) setModule(entityModules[0]!.name);
  }, [module, entityModules.length]);

  useEffect(() => {
    if (loaded || !settings) return;
    const row = settings.find((s) => (s as { key: string }).key === 'ui.list_columns');
    const value = (row as { value?: unknown } | undefined)?.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, string[]> = {};
      for (const [name, cols] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(cols)) out[name] = cols.filter((c): c is string => typeof c === 'string');
      }
      setChosen(out);
    }
    setLoaded(true);
  }, [settings, loaded]);

  const { data: meta } = useQuery({
    queryKey: ['module', module],
    queryFn: () => api.module(module),
    enabled: Boolean(module),
  });

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;

  /* What a table can show: everything a person could read, in module order. */
  const offerable: FieldMeta[] = (meta?.fields ?? [])
    .filter((f: FieldMeta) => f.isActive && f.displayType !== 'hidden')
    .sort((a: FieldMeta, b: FieldMeta) => a.sequence - b.sequence || a.label.localeCompare(b.label));

  const picked = chosen[module] ?? [];
  const byName = new Map(offerable.map((f) => [f.name, f]));

  const setPicked = (next: string[]): void => setChosen((cur) => ({ ...cur, [module]: next }));
  const toggle = (name: string): void =>
    setPicked(picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name]);
  const move = (index: number, delta: number): void => {
    const next = [...picked];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setPicked(next);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      /*
        Every module in one write, not just the one on screen. The setting is a
        single row holding all of them, so saving only the open module would
        blank the other one — which is exactly the kind of quiet data loss a
        settings page should not be capable of.
      */
      await api.saveSettings({ 'ui.list_columns': chosen });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'ui'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      // The store reads `me` only at start-up, so without this the save is
      // real and invisible until somebody reloads the page.
      await useApp.getState().refreshUser();
      toast.success('Table view saved', 'Everybody sees these columns, in this order.');
    } catch (err) {
      toast.error('Could not save the table view', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Table view</h1>
        <p className="mt-1 text-sm text-muted">
          The columns every list shows, in order. One arrangement for the whole team —
          nobody can change it from a list.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={module}
          onChange={(value) => setModule(value)}
          options={entityModules.map((m) => ({ value: m.name, label: m.label }))}
        />
        <button className="btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
        {picked.length > 0 && (
          <button
            className="btn-secondary btn-sm"
            onClick={() => setPicked([])}
            title="Clear this module's arrangement and fall back to the shipped columns"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Use the shipped columns
          </button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-3">
          <h2 className="mb-2 text-sm font-semibold">Shown, in this order</h2>
          {picked.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-muted dark:border-slate-700">
              Nothing chosen — every list falls back to the shipped columns.
            </p>
          ) : (
            <ol className="space-y-1">
              {picked.map((name, index) => {
                const field = byName.get(name);
                return (
                  <li
                    key={name}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm',
                      field
                        ? 'border-slate-200 dark:border-slate-700'
                        : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40',
                    )}
                  >
                    <span className="w-5 shrink-0 text-center text-xs text-muted tabular-nums">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {field?.label ?? name}
                      {/* A field that has been renamed or removed is named
                          rather than hidden: the list skips it silently, and an
                          admin should be able to see why a column vanished. */}
                      {!field && <span className="ml-1 text-xs font-medium text-amber-700 dark:text-amber-300">— no longer on this module</span>}
                    </span>
                    <button className="btn-ghost p-1" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${field?.label ?? name} up`}>
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button className="btn-ghost p-1" disabled={index === picked.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${field?.label ?? name} down`}>
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    <button className="btn-ghost p-1 text-xs" onClick={() => toggle(name)} aria-label={`Remove ${field?.label ?? name}`}>
                      Remove
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="card p-3">
          <h2 className="mb-2 text-sm font-semibold">Available</h2>
          <div className="max-h-[26rem] space-y-0.5 overflow-y-auto">
            {offerable.map((field) => (
              <label
                key={field.name}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <input
                  type="checkbox"
                  checked={picked.includes(field.name)}
                  onChange={() => toggle(field.name)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-0"
                />
                <span className="min-w-0 flex-1 truncate">{field.label}</span>
                <span className="shrink-0 text-xs text-muted">{field.uitype}</span>
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
