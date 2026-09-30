/**
 * The split view, drawn as the admin arranges it.
 *
 * **29 September 2026, the owner:** *"I need a proper layout designer in admin
 * panel for split view … right now its there but not at all properly made and
 * usable … looks complex to use."* The old screen was one long form of lists
 * whose names did not say where anything landed, and half of its controls —
 * the tabs, the tab a record opens on, the header's key fields — changed
 * nothing on the split view at all.
 *
 * So each zone here is named after the part of the screen it changes, shows a
 * preview built from a real record, and every control in it is read by the
 * split view (`lib/splitViewLayout.ts` is where the two sides agree).
 */
import { type JSX, type ReactNode, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, RotateCcw, X } from 'lucide-react';
import type { SplitTab } from '../../lib/splitViewLayout';
import { queueLinePreview } from '../../lib/splitViewLayout';
import { cn } from '../../lib/utils';
import { Select } from '../../components/ui';

export interface FieldOption { value: string; label: string }

/** A numbered zone card: which part of the split view this is, and what it changes. */
export function Zone({ step, title, hint, onReset, children, testId }: {
  step: number;
  title: string;
  hint: string;
  /** Present when the zone has been changed from what the CRM ships. */
  onReset?: () => void;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <section className="card overflow-hidden" data-testid={testId}>
      <header className="flex items-start gap-2.5 border-b border-slate-100 bg-slate-50/70 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-bold text-white">{step}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-2xs text-muted">{hint}</span>
        </span>
        {onReset && (
          <button type="button" onClick={onReset} className="btn-ghost btn-sm shrink-0 text-2xs" title="Go back to what the CRM shows out of the box">
            <RotateCcw className="h-3 w-3" /> Default
          </button>
        )}
      </header>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  );
}

/** The "what a rep will see" box inside a zone. */
export function Preview({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-brand-200 bg-brand-50/40 p-2.5 dark:border-brand-900 dark:bg-brand-950/20">
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">Preview</p>
      {children}
    </div>
  );
}

/**
 * An ordered list of fields: drag to reorder, arrows for anyone not using a
 * mouse, a cross to take one out, and a picker to add one. Each chip shows the
 * preview record's value under the name, so an admin can see a field is empty
 * on most records before choosing it.
 */
export function OrderedFieldList({ value, options, sampleOf, onChange, emptyText, label }: {
  value: string[];
  options: FieldOption[];
  sampleOf: (name: string) => string;
  onChange: (next: string[]) => void;
  emptyText: string;
  /** Names the list for screen readers and the tests. */
  label: string;
}): JSX.Element {
  const [dragging, setDragging] = useState<string | null>(null);
  const labelOf = (name: string): string => options.find((option) => option.value === name)?.label ?? name;
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  const unused = options.filter((option) => !value.includes(option.value));

  return (
    <div>
      <ol className="space-y-1" aria-label={label}>
        {value.map((name, index) => (
          <li
            key={name}
            draggable
            onDragStart={() => setDragging(name)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging && dragging !== name) move(value.indexOf(dragging), index);
              setDragging(null);
            }}
            className={cn(
              'flex cursor-grab items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs active:cursor-grabbing dark:border-slate-700 dark:bg-slate-800',
              dragging === name && 'opacity-40',
            )}
          >
            <GripVertical className="h-3 w-3 shrink-0 text-slate-300" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{labelOf(name)}</span>
              <span className="block truncate text-2xs text-muted">{sampleOf(name) || 'empty on this record'}</span>
            </span>
            <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0} className="btn-ghost p-0.5 disabled:opacity-25" aria-label={`Move ${labelOf(name)} up`}>
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => move(index, index + 1)} disabled={index === value.length - 1} className="btn-ghost p-0.5 disabled:opacity-25" aria-label={`Move ${labelOf(name)} down`}>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => onChange(value.filter((item) => item !== name))} className="btn-ghost p-0.5 text-slate-400 hover:text-red-500" aria-label={`Remove ${labelOf(name)}`}>
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ol>
      {value.length === 0 && <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-muted dark:border-slate-700">{emptyText}</p>}
      {unused.length > 0 && (
        <Select
          value=""
          placeholder="+ Add a field…"
          onChange={(name) => name && onChange([...value, name])}
          options={unused}
          className="mt-2 w-full py-1.5 text-xs"
        />
      )}
    </div>
  );
}

/** Zone 1's preview: one queue card, as the queue draws its middle line. */
export function QueueCardPreview({ name, values }: { name: string; values: string[] }): JSX.Element {
  const line = queueLinePreview(values);
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
      <p className="truncate text-sm font-bold text-slate-900 dark:text-white">{name}</p>
      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{line || <span className="text-muted">Nothing to show on this record</span>}</p>
    </div>
  );
}

/** Zone 2's preview: the pinned facts as the right pane draws them, one row each, then the call log. */
export function HeaderFactsPreview({ facts }: { facts: { label: string; value: string }[] }): JSX.Element {
  return (
    <div className="space-y-1 rounded-lg bg-white px-3 py-2 dark:bg-slate-900">
      {[...facts, { label: 'Call Log', value: 'last outcome' }].map((fact) => (
        <div key={fact.label} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{fact.label}</span>
          <span className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">{fact.value || '—'}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Zone 3: the tabs under the header — rename, reorder, hide, restore. The
 * first one is the tab every record opens on, which is simpler to explain than
 * a separate "opens on" setting that could name a hidden tab.
 */
export function TabsEditor({ tabs, all, onChange }: {
  tabs: SplitTab[];
  all: SplitTab[];
  onChange: (next: SplitTab[]) => void;
}): JSX.Element {
  const hidden = all.filter((tab) => !tabs.some((shown) => shown.key === tab.key));
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= tabs.length) return;
    const next = [...tabs];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <Preview>
        <div className="flex flex-wrap gap-1 border-b border-slate-200 text-xs font-semibold dark:border-slate-700">
          {tabs.map((tab, index) => (
            <span key={tab.key} className={cn('border-b-2 px-2 py-1.5', index === 0 ? 'border-brand-600 text-brand-600 dark:text-brand-300' : 'border-transparent text-slate-500')}>
              {tab.label}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-2xs text-muted">A record opens on <strong>{tabs[0]?.label}</strong>.</p>
      </Preview>
      <ol className="space-y-1" aria-label="Tabs">
        {tabs.map((tab, index) => (
          <li key={tab.key} className="flex items-center gap-1.5 rounded-lg border border-slate-200 p-1.5 dark:border-slate-700">
            <input
              className="input min-w-0 flex-1 py-1 text-xs"
              value={tab.label}
              aria-label={`Name of the ${tab.key} tab`}
              onChange={(event) => onChange(tabs.map((item) => (item.key === tab.key ? { ...item, label: event.target.value } : item)))}
            />
            {index === 0 && <span className="shrink-0 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 dark:bg-brand-950/60 dark:text-brand-200">Opens here</span>}
            <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0} className="btn-ghost p-0.5 disabled:opacity-25" aria-label={`Move ${tab.label} up`}>
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => move(index, index + 1)} disabled={index === tabs.length - 1} className="btn-ghost p-0.5 disabled:opacity-25" aria-label={`Move ${tab.label} down`}>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onChange(tabs.filter((item) => item.key !== tab.key))}
              disabled={tabs.length === 1}
              title={tabs.length === 1 ? 'A record needs at least one tab' : 'Hide this tab'}
              className="btn-ghost p-0.5 text-slate-400 hover:text-red-500 disabled:opacity-25"
              aria-label={`Hide ${tab.label}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ol>
      {hidden.length > 0 && (
        <Select
          value=""
          placeholder="+ Show a hidden tab…"
          onChange={(key) => {
            const tab = hidden.find((item) => item.key === key);
            if (tab) onChange([...tabs, tab]);
          }}
          options={hidden.map((tab) => ({ value: tab.key, label: tab.label }))}
          className="w-full py-1.5 text-xs"
        />
      )}
    </div>
  );
}
