import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Globe, GripVertical, LayoutDashboard, MapPin, Plus, Save, Trash2 } from 'lucide-react';
import type { HeaderTab } from '@ipropy/shared';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { Select, Skeleton, Spinner } from '../../components/ui';

/**
 * The header's tabs, arranged without a developer.
 *
 * Order, names, and what exists at all are the admin's: move a tab left or
 * right, rename it to the team's word for it, add a link to anywhere, or take
 * one out. The arrangement is a setting (`ui.header_tabs`), so it applies to
 * every screen in the CRM without a deploy.
 *
 * One thing it deliberately cannot do: hide a module. Modules the arrangement
 * does not name are appended after it, because a module that could be made
 * invisible by an arrangement nobody remembers making is a support ticket
 * waiting to happen. Module order, labels and visibility live on the module
 * itself (Modules & Fields / Enable-Disable).
 */
export default function HeaderTabsAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const { data: modules } = useQuery({ queryKey: ['modules'], queryFn: () => api.modules() });

  const [tabs, setTabs] = useState<HeaderTab[] | null>(null);
  const [socialPosition, setSocialPosition] = useState<'brand' | 'right' | 'hidden'>('right');
  const [saving, setSaving] = useState(false);

  // Where the social icons sit — the other half of the header this page owns.
  const { data: settings } = useQuery({ queryKey: ['settings', 'ui'], queryFn: () => api.settings('ui') });
  useEffect(() => {
    if (!settings || tabs) return;
    const byKey = new Map(settings.map((s) => [(s as { key: string }).key, (s as { value: unknown }).value]));
    const pos = byKey.get('ui.social_position');
    if (pos === 'brand' || pos === 'right' || pos === 'hidden') setSocialPosition(pos);
  }, [settings, tabs]);

  useEffect(() => {
    if (tabs || !me?.ui) return;
    setTabs(me.ui.headerTabs ?? []);
  }, [me?.ui, tabs]);

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-64 w-full" /></div>;

  const entityModules = (modules ?? []).filter((m) => m.isEntity && m.showInMenu);
  const namedModules = new Set((tabs ?? []).filter((t) => t.kind === 'module').map((t) => t.value));

  const update = (i: number, patch: Partial<HeaderTab>): void => {
    setTabs((cur) => (cur ?? []).map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  };

  const move = (i: number, delta: number): void => {
    setTabs((cur) => {
      const next = [...(cur ?? [])];
      const target = i + delta;
      if (target < 0 || target >= next.length) return cur;
      [next[i], next[target]] = [next[target]!, next[i]!];
      return next;
    });
  };

  const add = (t: HeaderTab): void => setTabs((cur) => [...(cur ?? []), t]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSettings({
        'ui.header_tabs': tabs ?? [],
        'ui.social_position': socialPosition,
      });
      toast.success('Header saved', 'The team sees the new arrangement on their next page load.');
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'ui'] });
      window.location.reload();
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const labelFor = (t: HeaderTab): string => {
    switch (t.kind) {
      case 'dashboard': return t.label ?? 'Dashboard';
      case 'capture': return t.label ?? 'Site visit';
      case 'reports': return t.label ?? 'Reports';
      case 'module': {
        const m = entityModules.find((x) => x.name === t.value);
        return t.label ?? m?.label ?? t.value ?? 'Module';
      }
      default: return t.label ?? t.value ?? 'Link';
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Header Tabs</h1>
          <p className="text-sm text-muted">
            The tabs across the top of the CRM — their order, their names, and what else belongs up there.
          </p>
        </div>
        <button className="btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save header
        </button>
      </div>

      <div className="card space-y-3 p-4">
        {/* A live preview of the strip, wearing the admin's names and order. */}
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50/60 px-2 py-2 dark:border-slate-800 dark:bg-slate-800/40">
          {(tabs ?? []).length === 0 && (
            <p className="px-2 text-xs text-muted">
              Empty arrangement — modules appear in their own order, with Dashboard first.
            </p>
          )}
          {(tabs ?? []).map((t, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-sm font-medium text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-200">
              {t.kind === 'dashboard' && <LayoutDashboard className="h-3.5 w-3.5" />}
              {t.kind === 'capture' && <MapPin className="h-3.5 w-3.5" />}
              {t.kind === 'reports' && <BarChart3 className="h-3.5 w-3.5" />}
              {t.kind === 'module' && <Globe className="h-3.5 w-3.5 text-slate-400" />}
              {t.kind === 'link' && <Globe className="h-3.5 w-3.5 text-slate-400" />}
              {labelFor(t)}
            </span>
          ))}
        </div>

        {(tabs ?? []).map((t, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 p-2 dark:border-slate-800">
            <span className="cursor-grab text-slate-300 active:cursor-grabbing dark:text-slate-600" aria-hidden>
              <GripVertical className="h-4 w-4" />
            </span>
            <div className="flex shrink-0 flex-col">
              <button className="text-slate-300 hover:text-brand-600 disabled:opacity-30 dark:text-slate-600"
                aria-label="Move earlier" onClick={() => move(i, -1)} disabled={i === 0}>▲</button>
              <button className="text-slate-300 hover:text-brand-600 disabled:opacity-30 dark:text-slate-600"
                aria-label="Move later" onClick={() => move(i, 1)} disabled={i === (tabs ?? []).length - 1}>▼</button>
            </div>
            <div className="min-w-[7rem]">
              <Select
                value={t.kind}
                onChange={(v) => update(i, { kind: v as HeaderTab['kind'], value: v === 'module' || v === 'link' ? '' : undefined })}
                options={[
                  { value: 'dashboard', label: 'Dashboard' },
                  { value: 'capture', label: 'Site visit' },
                  { value: 'reports', label: 'Reports' },
                  { value: 'module', label: 'A module' },
                  { value: 'link', label: 'A link' },
                ]}
              />
            </div>
            {t.kind === 'module' && (
              <div className="min-w-[9rem]">
                <Select
                  value={t.value ?? ''}
                  onChange={(v) => update(i, { value: v })}
                  placeholder="— Module —"
                  options={entityModules.map((m) => ({ value: m.name, label: m.label }))}
                />
              </div>
            )}
            {t.kind === 'link' && (
              <input
                className="input min-w-[10rem] flex-1"
                placeholder="https://…"
                value={t.value ?? ''}
                onChange={(e) => update(i, { value: e.target.value })}
              />
            )}
            <input
              className="input min-w-[8rem] flex-1"
              placeholder={`Label (default: ${t.kind === 'module' ? 'module name' : labelFor({ kind: t.kind } as HeaderTab)})`}
              value={t.label ?? ''}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <button
              className="btn-ghost p-1.5 text-slate-400 hover:text-red-600"
              aria-label="Remove this tab"
              onClick={() => setTabs((cur) => (cur ?? []).filter((_, idx) => idx !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary btn-sm" onClick={() => add({ kind: 'dashboard' })}>
            <Plus className="h-3.5 w-3.5" /> Dashboard
          </button>
          <button className="btn-secondary btn-sm" onClick={() => add({ kind: 'capture' })}>
            <Plus className="h-3.5 w-3.5" /> Site visit
          </button>
          <p className="w-full text-2xs text-muted">
            Site visit shows on phones regardless (bottom bar and menu). Placing it here also puts it
            on the desktop header, beside Properties&rsquo; &ldquo;New&rdquo; button.
          </p>
          <button className="btn-secondary btn-sm" onClick={() => add({ kind: 'reports' })}>
            <Plus className="h-3.5 w-3.5" /> Reports
          </button>
          <button className="btn-secondary btn-sm" onClick={() => add({ kind: 'link', value: '' })}>
            <Plus className="h-3.5 w-3.5" /> A link
          </button>
        </div>

        {entityModules.filter((m) => !namedModules.has(m.name)).length > 0 && (
          <div className="rounded-lg border border-dashed border-slate-300 p-3 text-xs text-muted dark:border-slate-700">
            Also in the header, after the arrangement: {' '}
            {entityModules.filter((m) => !namedModules.has(m.name)).map((m) => (
              <button
                key={m.name}
                className="mx-0.5 inline-flex items-center gap-1 rounded-full border border-slate-300 px-2 py-0.5 text-2xs hover:border-brand-500 hover:text-brand-700 dark:border-slate-600 dark:hover:text-brand-300"
                onClick={() => add({ kind: 'module', value: m.name })}
              >
                {m.label} <Plus className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card mt-4 p-4">
        <label className="label">Social icons</label>
        <Select
          value={socialPosition}
          onChange={(v) => setSocialPosition(v as 'brand' | 'right' | 'hidden')}
          options={[
            { value: 'right', label: 'On the right, beside search' },
            { value: 'brand', label: 'Next to the logo' },
            { value: 'hidden', label: 'Nowhere — hide them' },
          ]}
        />
        <p className="mt-1 text-2xs text-muted">
          The accounts themselves are the social list on the Brand &amp; social page.
        </p>
      </div>
    </div>
  );
}
