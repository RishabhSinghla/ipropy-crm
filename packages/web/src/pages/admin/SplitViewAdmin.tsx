import { type JSX, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, RotateCcw, Save } from 'lucide-react';
import type { FieldMeta, SplitViewLayout } from '@ipropy/shared';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Select, Skeleton, Spinner } from '../../components/ui';

/**
 * One split view for the whole team, the same way Table View is one table.
 *
 * The split view is where most of the team now works all day, and until this
 * screen existed the three places a field can appear in it were set in three
 * different places: the line under a name came from a per-field flag in the
 * Field Manager, and the record's header and form came from the Layout
 * Designer. So "put the budget next to the phone number" meant knowing which
 * of three screens owned that particular strip.
 *
 * Three lists here, because they answer three different questions:
 *
 *  * **Left pane** — the one line under each name in the queue, joined with a
 *    hyphen. Keep it to a couple of facts; it is a line in a narrow column,
 *    not a second row of the record.
 *  * **Record header** — the strip beside the open record's name.
 *  * **Record form** — the fields below it.
 *
 * **Every list left empty keeps what the CRM ships**, and that is the whole
 * safety of this page: an admin who opens it, looks and leaves changes
 * nothing, and a module nobody has arranged looks exactly as it does today.
 * The fallbacks are the fields flagged to show under a name, and the Layout
 * Designer's header and blocks.
 *
 * The fields offered are read from the module itself, so one added this
 * morning is offerable this afternoon with no deploy.
 */

type PaneKey = 'queue' | 'header' | 'form';

const PANES: { key: PaneKey; title: string; blurb: string; fallback: string }[] = [
  {
    key: 'queue',
    title: 'Left pane — under each name',
    blurb: 'Joined with a hyphen, so two facts read as "Buyer — 304". Keep it short.',
    fallback: 'the fields flagged to show under a name',
  },
  {
    key: 'header',
    title: 'Right pane — the record header',
    blurb: 'The strip beside the open record’s name.',
    fallback: 'the Layout Designer’s header fields',
  },
  {
    key: 'form',
    title: 'Right pane — the form',
    blurb: 'The fields below the header, in one card, in this order.',
    fallback: 'the Layout Designer’s blocks',
  },
];

const EMPTY: SplitViewLayout = { queue: [], header: [], form: [] };

export default function SplitViewAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { data: modules, isLoading } = useQuery({ queryKey: ['modules'], queryFn: () => api.modules() });
  const { data: settings } = useQuery({ queryKey: ['settings', 'ui'], queryFn: () => api.settings('ui') });

  const [module, setModule] = useState<string>('');
  const [chosen, setChosen] = useState<Record<string, SplitViewLayout>>({});
  const [pane, setPane] = useState<PaneKey>('queue');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const entityModules = (modules ?? []).filter((m) => m.isEntity && m.showInMenu);
  useEffect(() => {
    if (!module && entityModules.length) setModule(entityModules[0]!.name);
  }, [module, entityModules.length]);

  useEffect(() => {
    if (loaded || !settings) return;
    const row = settings.find((s) => (s as { key: string }).key === 'ui.split_view');
    const value = (row as { value?: unknown } | undefined)?.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, SplitViewLayout> = {};
      for (const [name, panes] of Object.entries(value as Record<string, unknown>)) {
        if (!panes || typeof panes !== 'object' || Array.isArray(panes)) continue;
        const row_ = panes as Record<string, unknown>;
        const names = (list: unknown): string[] => (Array.isArray(list)
          ? list.filter((n): n is string => typeof n === 'string')
          : []);
        out[name] = { queue: names(row_.queue), header: names(row_.header), form: names(row_.form) };
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

  /* What the split view can show: everything a person could read, in module order. */
  const offerable: FieldMeta[] = useMemo(() => (meta?.fields ?? [])
    .filter((f: FieldMeta) => f.isActive && f.displayType !== 'hidden')
    .sort((a: FieldMeta, b: FieldMeta) => a.sequence - b.sequence || a.label.localeCompare(b.label)),
  [meta?.fields]);

  const layout = chosen[module] ?? EMPTY;
  const picked = layout[pane];
  const byName = new Map(offerable.map((f) => [f.name, f]));
  const current = PANES.find((p) => p.key === pane)!;

  const setPicked = (next: string[]): void =>
    setChosen((cur) => ({ ...cur, [module]: { ...(cur[module] ?? EMPTY), [pane]: next } }));
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
        Every module and all three panes in one write. The setting is a single
        row holding the lot, so saving only what is on screen would blank the
        rest — exactly the kind of quiet data loss a settings page should not
        be capable of.
      */
      await api.saveSettings({ 'ui.split_view': chosen });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'ui'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.success('Split view saved', 'Everybody sees these fields, in this order.');
    } catch (err) {
      toast.error('Could not save the split view', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /*
    Nothing is offered until the saved arrangement has arrived.

    The settings request resolves *after* the first paint, and it calls
    `setChosen` — so a field ticked in that gap is wiped by the response, with
    no error and nothing on screen to say why. It reads exactly like a checkbox
    that does not work, and it cost a test run to see.
  */
  if (isLoading || !loaded) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Split view</h1>
        <p className="mt-1 text-sm text-muted">
          What the split view shows, in order — the queue on the left, and the open record&rsquo;s
          header and form on the right. One arrangement for the whole team.
          Anything left empty keeps what the CRM already shows.
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
            title={`Clear this list and fall back to ${current.fallback}`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Use what the CRM shows
          </button>
        )}
      </div>

      {/* One pane at a time. Three pickers side by side would each be a third
          of a screen wide, and the field labels are what somebody is reading. */}
      <div className="flex flex-wrap gap-1.5">
        {PANES.map((option) => {
          const count = (chosen[module] ?? EMPTY)[option.key].length;
          return (
            <button
              key={option.key}
              onClick={() => setPane(option.key)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                pane === option.key
                  ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                  : 'border-slate-200 text-slate-600 hover:border-brand-300 dark:border-slate-700 dark:text-slate-300',
              )}
            >
              {option.title}
              <span className="ml-1.5 text-xs text-muted">{count || '—'}</span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted">{current.blurb}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-3">
          <h2 className="mb-2 text-sm font-semibold">Shown, in this order</h2>
          {picked.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-muted dark:border-slate-700">
              Nothing chosen — this falls back to {current.fallback}.
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
                      {/* A field that has been renamed or removed is named rather
                          than hidden: the split view skips it silently, and an
                          admin should be able to see why something vanished. */}
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
