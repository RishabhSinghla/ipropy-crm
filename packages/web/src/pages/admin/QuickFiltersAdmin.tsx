/**
 * Admin → Quick Filters — the master for the Quick & Live Filters panel.
 *
 * **1 October 2026, the owner:** *"make a proper master … for this quick live
 * filter thing so you know I need not ask you again and again for changes."*
 *
 * Per module: which sections the panel shows, in what order, under what name,
 * which open unfolded, and how many values a long list shows before its search.
 * The live panel sits beside the editor and redraws as you change it — the
 * real component, not a picture of one — so what is saved is what the team
 * gets.
 *
 * Stored as `ui.quick_filters` (`{ module: sections[] }`). A module nobody has
 * arranged uses the shipped arrangement, built from its own fields
 * (`defaultQuickSections`), and **Reset to default** gives that back. A field
 * added after the arrangement is saved is appended by the panel on its own.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FilterGroup, QuickFilterSection } from '@ipropy/shared';
import { EMPTY_FILTER } from '@ipropy/shared';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw, Save, Undo2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { assignmentField, followUpFieldOf, pipelineFieldOf } from '../../lib/fields';
import { arrangeQuickSections, defaultQuickSections, sectionLabel, type QuickPick, type QuickPicks } from '../../lib/quickFilters';
import { cn } from '../../lib/utils';
import { QuickFilterOverlay } from '../../components/QuickFilterOverlay';
import { NO_DISPOSITION_PICK, type DispositionPick } from '../../components/CallDispositionFilter';
import type { TaskQueue } from '../../components/FollowUpQueue';
import { Spinner } from '../../components/ui';

const SETTING = 'ui.quick_filters';

const KIND_LABEL: Record<QuickFilterSection['kind'], string> = {
  agent: 'People', list: 'Saved lists', tags: 'Tags', stage: 'Pipeline', calls: 'Last call', task: 'Follow-up date',
  values: 'Tick list', range: 'Min–max slider', date: 'Date presets',
};

/** Kinds that show a list of values, and so have a "top N" before their search. */
const LISTS = new Set<QuickFilterSection['kind']>(['agent', 'list', 'tags', 'stage', 'calls', 'values']);

export default function QuickFiltersAdmin(): JSX.Element {
  const { modules, refreshUser } = useApp();
  const entityModules = modules.filter((module) => module.isEntity);
  const [moduleName, setModuleName] = useState(entityModules[0]?.name ?? 'leads');

  const { data: meta } = useQuery({ queryKey: ['module', moduleName], queryFn: () => api.module(moduleName) });
  const { data: rows, refetch } = useQuery({ queryKey: ['settings', 'ui'], queryFn: () => api.settings('ui') });
  const saved = useMemo(() => {
    const value = rows?.find((row) => row.key === SETTING)?.value;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, QuickFilterSection[]> : {};
  }, [rows]);

  const covered = useMemo(() => (meta ? {
    ownerField: assignmentField(meta.fields),
    stageField: pipelineFieldOf(meta),
    taskField: followUpFieldOf(meta.fields),
  } : {}), [meta]);
  const defaults = useMemo(() => (meta ? defaultQuickSections(meta.fields, covered) : []), [meta, covered]);
  const fields = useMemo(() => new Map((meta?.fields ?? []).map((field) => [field.name, field])), [meta]);

  const [draft, setDraft] = useState<QuickFilterSection[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  // Start from what is saved for this module, laid over what it has today.
  const startFrom = (): void => {
    setDraft(arrangeQuickSections(saved[moduleName], defaults));
    setDirty(false);
  };
  useEffect(startFrom, [moduleName, saved, defaults]);

  const change = (next: QuickFilterSection[]): void => { setDraft(next); setDirty(true); };
  const update = (index: number, patch: Partial<QuickFilterSection>): void => (
    change(draft.map((section, at) => (at === index ? { ...section, ...patch } : section)))
  );
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= draft.length || from === to) return;
    const next = [...draft];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    change(next);
  };

  const write = async (value: Record<string, QuickFilterSection[]>, message: string): Promise<void> => {
    setSaving(true);
    try {
      await api.saveSettings({ [SETTING]: value });
      await Promise.all([refetch(), refreshUser()]);
      setDirty(false);
      toast.success(message);
    } catch (err) {
      toast.error('Could not save the quick filters', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const save = (): Promise<void> => write({ ...saved, [moduleName]: draft }, 'Quick filters saved — the team sees them on their next page load');
  const reset = (): Promise<void> => {
    const { [moduleName]: _dropped, ...rest } = saved;
    return write(rest, 'Back to the shipped quick filters');
  };

  // The preview is the real panel, so its choices are real state too — kept here, never saved.
  const [picks, setPicks] = useState<QuickPicks>({});
  const [agent, setAgent] = useState<string | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  const [task, setTask] = useState<TaskQueue | null>(null);
  const [disposition, setDisposition] = useState<DispositionPick>(NO_DISPOSITION_PICK);
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER);

  const switchModule = (name: string): void => {
    if (dirty && !window.confirm('Leave without saving your changes to this module?')) return;
    setModuleName(name);
    setPicks({});
  };

  const shownCount = draft.filter((section) => !section.hidden).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">Quick Filters</h1>
          <p className="text-sm text-muted">
            What the Quick &amp; Live Filters panel offers, in what order and under what name. Switch a filter off with the eye,
            drag or use the arrows to reorder, and rename any heading. The panel on the right is the real one — try it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input h-9 py-0 text-sm"
            value={moduleName}
            onChange={(event) => switchModule(event.target.value)}
            aria-label="Module"
          >
            {entityModules.map((module) => <option key={module.name} value={module.name}>{module.label}</option>)}
          </select>
          <button type="button" className="btn-secondary btn-sm" disabled={!dirty || saving} onClick={startFrom}>
            <Undo2 className="h-3.5 w-3.5" /> Undo changes
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={saving || !saved[moduleName]}
            title={saved[moduleName] ? 'Forget this module’s arrangement and use the shipped one' : 'This module already uses the shipped arrangement'}
            onClick={() => { if (window.confirm('Reset this module’s quick filters to the shipped arrangement?')) void reset(); }}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to default
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      {!meta ? (
        <div className="flex min-h-40 items-center justify-center"><Spinner className="h-5 w-5" /></div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22.5rem]">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs">
              <span className="font-semibold">{shownCount} of {draft.length} filters shown</span>
              <span className="text-muted">Top = how many values a long list shows before its search</span>
            </div>
            <ol aria-label="Quick filter sections" data-testid="quick-filter-master">
              {draft.map((section, index) => {
                const title = sectionLabel({ ...section, label: undefined }, fields, covered.stageField?.label);
                return (
                  <li
                    key={section.key}
                    draggable
                    onDragStart={() => setDragFrom(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => { if (dragFrom !== null) move(dragFrom, index); setDragFrom(null); }}
                    className={cn(
                      'flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2 last:border-b-0',
                      section.hidden && 'bg-slate-50 opacity-60 dark:bg-slate-800/40',
                      dragFrom === index && 'ring-2 ring-inset ring-brand-400',
                    )}
                  >
                    <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-slate-400" aria-hidden />
                    <button
                      type="button"
                      onClick={() => update(index, { hidden: !section.hidden })}
                      aria-pressed={!section.hidden}
                      aria-label={section.hidden ? `Show ${title}` : `Hide ${title}`}
                      title={section.hidden ? 'Hidden — click to show' : 'Shown — click to hide'}
                      className={cn('rounded p-1', section.hidden ? 'text-slate-400 hover:text-slate-700' : 'text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-950')}
                    >
                      {section.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                    <input
                      className="input h-8 min-w-[10rem] flex-1 py-0 text-sm"
                      value={section.label ?? ''}
                      placeholder={title}
                      aria-label={`Heading for ${title}`}
                      onChange={(event) => update(index, { label: event.target.value || undefined })}
                    />
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {KIND_LABEL[section.kind]}
                    </span>
                    <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300" title="Opens unfolded rather than as a heading to tap">
                      <input type="checkbox" checked={Boolean(section.open)} onChange={(event) => update(index, { open: event.target.checked || undefined })} />
                      Open
                    </label>
                    {LISTS.has(section.kind) && (
                      <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300">
                        Top
                        <input
                          type="number"
                          min={1}
                          max={50}
                          className="input h-7 w-14 py-0 text-center text-xs"
                          value={section.top ?? 5}
                          aria-label={`How many of ${title} to show before the search`}
                          onChange={(event) => update(index, { top: Math.min(50, Math.max(1, Number(event.target.value) || 5)) })}
                        />
                      </label>
                    )}
                    <span className="flex shrink-0">
                      <button type="button" className="btn-ghost p-1 disabled:opacity-25" disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={`Move ${title} up`}>
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" className="btn-ghost p-1 disabled:opacity-25" disabled={index === draft.length - 1} onClick={() => move(index, index + 1)} aria-label={`Move ${title} down`}>
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* The real panel, drawn as it will be, in the right pane's own shape. */}
          <div className="relative h-[40rem] overflow-hidden rounded-xl border border-[var(--border)] bg-white dark:bg-slate-900" data-testid="quick-filter-preview">
            <QuickFilterOverlay
              // Remounted when an "Open" box changes, so the preview's folds follow it.
              key={`${moduleName}:${draft.map((section) => (section.open ? '1' : '0')).join('')}`}
              open
              onClose={() => { /* the preview stays open */ }}
              placement="pane"
              module={meta}
              sections={draft}
              count={undefined}
              counting={false}
              views={[]}
              onChooseView={() => {}}
              ownerField={covered.ownerField}
              agent={agent}
              onAgent={setAgent}
              stageField={covered.stageField}
              stages={stages}
              onStages={setStages}
              taskField={covered.taskField}
              task={task}
              onTask={setTask}
              disposition={disposition}
              onDisposition={setDisposition}
              picks={picks}
              onPick={(field: string, pick: QuickPick | null) => setPicks((current) => {
                const next = { ...current };
                if (pick) next[field] = pick; else delete next[field];
                return next;
              })}
              filter={filter}
              onFilter={setFilter}
              onClear={() => { setPicks({}); setAgent(null); setStages([]); setTask(null); setDisposition(NO_DISPOSITION_PICK); setFilter(EMPTY_FILTER); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
