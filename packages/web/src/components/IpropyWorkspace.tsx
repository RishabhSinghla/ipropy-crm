import { type JSX, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, ChevronRight, CircleDot, ExternalLink, Phone, Sparkles, Star, Tag, UserRound } from 'lucide-react';
import type { FieldMeta, ModuleMeta, RecordEnvelope } from '@ipropy/shared';
import { FieldValue } from './FieldRenderer';
import { ModuleIcon } from './Layout';
import { cn } from '../lib/utils';

/**
 * The iPROPY view is deliberately a different way of reading the same list,
 * not a second record model.  It receives the list query's rows and metadata,
 * so saved-view filters, permissions, labels and custom fields behave exactly
 * as they do in the table and board views.
 */
export function IpropyWorkspace({
  module, rows, columns, fieldMap, selected, attentionIds, onToggleSelect, onOpen,
}: {
  module: ModuleMeta;
  rows: RecordEnvelope[];
  columns: string[];
  fieldMap: Map<string, FieldMeta>;
  selected: Set<string>;
  attentionIds: Set<string>;
  onToggleSelect: (id: string, checked: boolean) => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(rows[0]?.id ?? null);

  // Filters, sorting, paging and live invalidation replace the row array. Keep
  // the inspector on its selected record when it still exists; otherwise move
  // to the first visible result rather than leaving a stale detail pane.
  useEffect(() => {
    setActiveId((current) => rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null));
  }, [rows]);

  const active = rows.find((row) => row.id === activeId) ?? rows[0] ?? null;
  const statusField = useMemo(
    () => module.fields.find((field) => field.name === module.pipelineField)
      ?? module.fields.find((field) => /status|stage/i.test(field.name)),
    [module.fields, module.pipelineField],
  );
  const followUpField = useMemo(
    () => module.fields.find((field) => field.columnName === 'next_followup_at')
      ?? module.fields.find((field) => /next.*follow.*up/i.test(field.name)),
    [module.fields],
  );
  const phoneField = useMemo(() => module.fields.find((field) => field.uitype === 'phone'), [module.fields]);
  const overviewFields = useMemo(() => {
    const identity = new Set(module.labelFields);
    const preferred = columns.length ? columns : module.fields.map((field) => field.name);
    return preferred
      .map((name) => fieldMap.get(name))
      .filter((field): field is FieldMeta => Boolean(field && field.isActive && field.displayType !== 'hidden'))
      .filter((field) => !identity.has(field.name) && field.uitype !== 'autonumber')
      .slice(0, 8);
  }, [columns, fieldMap, module.fields, module.labelFields]);

  return (
    <section data-testid="ipropy-workspace" className="min-h-full bg-[#f6f8f5] p-3 sm:p-5 dark:bg-slate-950">
      <div className="mx-auto grid max-w-[1680px] overflow-hidden rounded-2xl border border-emerald-950/10 bg-white shadow-sm lg:grid-cols-[minmax(18rem,23rem)_minmax(0,1fr)] dark:border-slate-800 dark:bg-slate-900">
        <aside className="border-b border-slate-200 bg-[#fbfcfa] lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-950/40">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                <ModuleIcon name={module.icon} className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{module.label}</p>
                <p className="text-2xs text-slate-500">iPROPY workspace</p>
              </div>
            </div>
            <span className="rounded-full bg-emerald-100 px-2 py-1 text-2xs font-bold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
              {rows.length} shown
            </span>
          </div>

          <div className="max-h-[30rem] overflow-y-auto lg:max-h-[calc(100vh-18rem)]">
            {rows.map((row) => {
              const isActive = row.id === active?.id;
              const status = statusField ? displayOf(row, statusField) : '';
              const followUp = followUpField ? dateLabel(row.values[followUpField.name]) : null;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setActiveId(row.id)}
                  className={cn(
                    'group flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left transition-colors dark:border-slate-800',
                    isActive ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70',
                  )}
                >
                  <input
                    aria-label={`Select ${row.label}`}
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onToggleSelect(row.id, event.target.checked)}
                    className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-slate-300"
                  />
                  <RecordGlyph module={module} row={row} active={isActive} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{row.label}</span>
                      {row.starred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" aria-label="Favourite" />}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-slate-500">{row.recordNumber ?? row.ownerName ?? module.singularLabel}</span>
                    <span className="mt-2 flex flex-wrap items-center gap-1.5">
                      {attentionIds.has(row.id) && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Needs attention" />}
                      {status && <StatusPill field={statusField} row={row} label={status} />}
                      {followUp && <span className="inline-flex items-center gap-1 text-2xs text-slate-500"><CalendarClock className="h-3 w-3" />{followUp}</span>}
                    </span>
                  </span>
                  <ChevronRight className={cn('mt-1 h-4 w-4 shrink-0 text-slate-300 transition-transform', isActive && 'translate-x-0.5 text-emerald-600')} />
                </button>
              );
            })}
          </div>
        </aside>

        {active ? (
          <article className="min-w-0">
            <header className="border-b border-slate-200 bg-gradient-to-r from-[#f8fcf8] to-[#fffaf0] px-5 py-5 dark:border-slate-800 dark:from-slate-900 dark:to-slate-900 sm:px-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <RecordGlyph module={module} row={active} active />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-xl font-bold tracking-tight text-slate-950 dark:text-white">{active.label}</h2>
                      {active.tags?.slice(0, 2).map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-2xs font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"><Tag className="h-2.5 w-2.5" />{tag}</span>)}
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" />{active.ownerName ?? 'Unassigned'}</span>
                      {active.recordNumber && <span className="font-mono text-2xs">{active.recordNumber}</span>}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {phoneField && displayOf(active, phoneField) && <a href={`tel:${String(active.values[phoneField.name])}`} className="btn-secondary btn-sm"><Phone className="h-3.5 w-3.5" />Call</a>}
                  <button type="button" className="btn-primary btn-sm" onClick={() => onOpen(active.id)}><ExternalLink className="h-3.5 w-3.5" />Open record</button>
                </div>
              </div>

              <div className="mt-5 grid gap-2 sm:grid-cols-3">
                <SummaryTile label={statusField?.label ?? 'Status'} icon={<CircleDot className="h-3.5 w-3.5" />} value={statusField ? displayOf(active, statusField) || 'Not set' : 'Not set'} />
                <SummaryTile label={followUpField?.label ?? 'Next follow-up'} icon={<CalendarClock className="h-3.5 w-3.5" />} value={followUpField ? dateLabel(active.values[followUpField.name]) ?? 'Not scheduled' : 'Not scheduled'} />
                <SummaryTile label="Workspace" icon={<Sparkles className="h-3.5 w-3.5" />} value={attentionIds.has(active.id) ? 'Needs attention' : 'Up to date'} emphasis={attentionIds.has(active.id) ? 'amber' : 'emerald'} />
              </div>
            </header>

            <div className="grid gap-5 p-5 sm:p-7 xl:grid-cols-[minmax(0,1fr)_17rem]">
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold text-slate-900 dark:text-slate-100">Overview</p>
                    <p className="text-2xs text-slate-500">Live values from this record</p>
                  </div>
                  {active.can?.edit && <span className="text-2xs font-medium text-emerald-700 dark:text-emerald-300">Editable in record</span>}
                </div>
                <dl className="grid overflow-hidden rounded-xl border border-slate-200 sm:grid-cols-2 dark:border-slate-800">
                  {overviewFields.map((field) => (
                    <div key={field.name} className="border-b border-slate-100 p-3 last:border-b-0 odd:sm:border-r dark:border-slate-800">
                      <dt className="mb-1 text-2xs font-semibold uppercase tracking-wide text-slate-500">{field.label}</dt>
                      <dd className="min-w-0 text-sm text-slate-800 dark:text-slate-100"><FieldValue field={field} value={active.values[field.name]} display={active.display?.[field.name]} compact /></dd>
                    </div>
                  ))}
                </dl>
              </section>
              <aside className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
                <p className="flex items-center gap-1.5 text-sm font-bold text-emerald-950 dark:text-emerald-100"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Work next</p>
                <p className="mt-2 text-xs leading-5 text-emerald-900/75 dark:text-emerald-200/75">Use the record page for notes, files, messages and full editing. This workspace keeps the list and the important details together.</p>
                <button type="button" onClick={() => onOpen(active.id)} className="mt-4 w-full rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-800">Continue with {module.singularLabel}</button>
              </aside>
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function RecordGlyph({ module, row, active }: { module: ModuleMeta; row: RecordEnvelope; active: boolean }): JSX.Element {
  return <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', active ? 'bg-emerald-700 text-white shadow-sm' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300')}><ModuleIcon name={module.icon} className="h-4 w-4" /><span className="sr-only">{row.label}</span></span>;
}

function StatusPill({ field, row, label }: { field: FieldMeta | undefined; row: RecordEnvelope; label: string }): JSX.Element {
  const value = field ? String(row.values[field.name] ?? '') : '';
  const color = field?.options?.find((option) => option.value === value)?.color;
  return <span className="rounded-full px-2 py-0.5 text-2xs font-semibold" style={color ? { backgroundColor: `${color}20`, color } : undefined}>{label}</span>;
}

function SummaryTile({ label, icon, value, emphasis = 'slate' }: { label: string; icon: JSX.Element; value: string; emphasis?: 'slate' | 'emerald' | 'amber' }): JSX.Element {
  const color = emphasis === 'emerald' ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200' : emphasis === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200' : 'border-white/80 bg-white/80 text-slate-800 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-100';
  return <div className={cn('rounded-xl border px-3 py-2.5', color)}><p className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide opacity-70">{icon}{label}</p><p className="mt-1 truncate text-sm font-bold">{value}</p></div>;
}

function displayOf(row: RecordEnvelope, field: FieldMeta): string {
  const display = row.display?.[field.name];
  if (display) return display;
  const value = row.values[field.name];
  if (Array.isArray(value)) return value.join(', ');
  return value === null || value === undefined ? '' : String(value);
}

function dateLabel(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
