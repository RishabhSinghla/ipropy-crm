import { type JSX, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronDown, ChevronUp, GripVertical, ListTree, Pencil, Plus, Save, Star, Trash2,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, ConfirmDialog, Modal, Skeleton, Spinner, Toggle } from '../../components/ui';

/**
 * The dropdown editor.
 *
 * Everything an admin can do to an option set lives here, because the
 * alternative is a phone call to a developer: rename the set, add and remove
 * options, reorder them, recolour them, pick the default, retire one without
 * losing history, and delete one for good.
 *
 * Two rules the UI exists to make visible:
 *
 *   * **A stored value is not a label.** Renaming the label is free. Renaming
 *     the *stored value* rewrites every record that holds it, so the editor
 *     tracks what each row was loaded as and tells the server, which moves the
 *     records in the same transaction.
 *   * **Deleting asks first.** An option nothing uses is deleted outright. One
 *     that records still hold cannot vanish silently, so the dialog says how
 *     many and makes the admin choose what those records should say instead.
 *
 * Each option is one line: select, reorder, name, colour, preview, default,
 * active, delete — side by side, so a long list scans as single rows and the
 * name never sits alone above the dressing. On a narrow screen the line wraps
 * inside itself rather than splitting into a separate indented row, so the
 * colour stays beside the name it belongs to even at phone width.
 */

interface Option {
  value: string;
  label: string;
  color: string | null;
  isActive: boolean;
  isDefault: boolean;
  /** What this row was called when it was loaded — absent on a new row. */
  previousValue?: string;
  /**
   * What in the application matches this option by its stored text, if
   * anything. Renaming rewrites records, saved views, widgets and workflow
   * rules; it cannot rewrite a query, so these need saying out loud.
   */
  usedInCode?: string | null;
}

const SWATCHES = ['#64748b', '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6',
  '#0ea5e9', '#6366f1', '#a855f7', '#ec4899'];

const slug = (label: string): string =>
  label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export default function PicklistManager(): JSX.Element {
  const queryClient = useQueryClient();
  // `?picklist=` so anything that depends on a dropdown can link straight at
  // it — the phone field's editor points here for its country codes.
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string>(params.get('picklist') || 'lead_status');
  const [options, setOptions] = useState<Option[]>([]);
  const [dirty, setDirty] = useState(false);
  /*
    Ticked options, by their stored value.

    This started as a single "Remove all" button, which was the wrong shape: on
    Locality he wanted to keep a handful of the 126 and lose the rest, and
    "remove everything then type the keepers back in" is not a saving. It was
    also refused outright whenever a required field used the dropdown, since
    those records cannot be left with nothing — so the one case it was built for
    was the one case it could not do.

    Ticking is better on both counts. Keep what you want, and each removal still
    answers the question the single delete asks: what happens to the records
    holding this value?
  */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState<Option | null>(null);
  // The stored value is the rare edit; it is off unless asked for. See the
  // note beside the option name input.
  const [showStored, setShowStored] = useState(false);

  const { data: catalogue, isLoading } = useQuery({
    queryKey: ['picklist-catalogue'],
    queryFn: () => api.picklistCatalogue(),
  });

  const current = useMemo(
    () => catalogue?.find((p) => p.name === selected),
    [catalogue, selected],
  );

  useEffect(() => {
    if (!current) return;
    setOptions(current.values.map((v) => ({
      value: v.value,
      label: v.label,
      color: v.color,
      isActive: v.isActive,
      isDefault: v.isDefault,
      previousValue: v.value,
      usedInCode: v.usedInCode ?? null,
    })));
    setDirty(false);
  }, [current]);

  // Land on something real: 'lead_status' is the sensible default but a
  // database that never seeded it would otherwise render an empty right pane.
  useEffect(() => {
    if (catalogue?.length && !catalogue.some((p) => p.name === selected)) {
      setSelected(catalogue[0].name);
    }
  }, [catalogue, selected]);

  // A tick means "remove this one"; carrying it to another dropdown would be a
  // very bad surprise.
  useEffect(() => { setPicked(new Set()); }, [selected]);

  const needle = search.toLowerCase().trim();
  const names = (catalogue ?? []).filter(
    (p) => !needle || p.label.toLowerCase().includes(needle) || p.name.includes(needle.replace(/\s/g, '_')),
  );

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['picklist-catalogue'] });
    void queryClient.invalidateQueries({ queryKey: ['picklists'] });
    void queryClient.invalidateQueries({ queryKey: ['module'] });
  };

  const update = (index: number, patch: Partial<Option>): void => {
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
    setDirty(true);
  };

  const moveTo = (from: number, to: number): void => {
    if (to < 0 || to >= options.length || from === to) return;
    setOptions((prev) => {
      const next = [...prev];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    const blank = options.find((o) => !o.label.trim());
    if (blank) {
      toast.error('Every option needs a name');
      return;
    }
    setSaving(true);
    try {
      const result = await api.savePicklistValues(selected, options.map((o) => ({
        value: o.value.trim(),
        label: o.label.trim(),
        color: o.color,
        isActive: o.isActive,
        isDefault: o.isDefault,
        ...(o.previousValue && o.previousValue !== o.value.trim()
          ? { previousValue: o.previousValue }
          : {}),
      })));
      if (result.skipped?.length) {
        // The server refused to re-create something deleted earlier. Saying so
        // matters: silently doing it is the bug this replaced.
        toast.error(
          'Deleted options were not added back',
          `${result.skipped.join(', ')} — deleted earlier. Use “Deleted options” below to restore.`,
        );
      }
      toast.success(
        'Dropdown saved',
        result.renamedRecords || result.renamedFilters
          ? `${options.length} options · ${result.renamedRecords} record${result.renamedRecords === 1 ? '' : 's'}`
            + `${result.renamedFilters ? ` and ${result.renamedFilters} saved view/rule` : ''} updated to match the rename`
          : `${options.length} options in ${current?.label ?? selected}`,
      );
      setDirty(false);
      refresh();
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Dropdowns</h1>
        <p className="text-sm text-muted">
          Every dropdown in the CRM. Changing an option updates it everywhere the option set is used.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="card h-fit overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 p-2 dark:border-slate-800">
            <input
              className="input py-1.5 text-sm"
              placeholder="Search dropdowns…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              onClick={() => setCreating(true)}
              className="btn-secondary btn-sm shrink-0"
              title="New dropdown"
              aria-label="New dropdown"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-[32rem] overflow-y-auto p-1.5">
            {isLoading ? (
              <div className="space-y-1">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
            ) : names.map((p) => (
              <button
                key={p.name}
                onClick={() => setSelected(p.name)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                  selected === p.name
                    ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                <span className="truncate">{p.label}</span>
                <span className="shrink-0 text-2xs text-muted tnum">{p.values.length}</span>
              </button>
            ))}
            {!isLoading && names.length === 0 && (
              <p className="px-2.5 py-6 text-center text-xs text-muted">No dropdown matches that</p>
            )}
          </div>
        </div>

        <div className="card overflow-hidden">
          {/* The controls row is one line that holds: what this set is, the
              rare-edit toggle, add, remove-ticked and save. Wrapping here is
              what made the panel feel broken before. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <ListTree className="h-4 w-4 shrink-0 text-slate-400" />
            <p className="text-sm font-medium">{current?.label ?? selected}</p>
            <span className="text-2xs text-muted tnum">{options.length} options</span>
            <button
              onClick={() => setRenaming(true)}
              disabled={!current}
              className="btn-ghost btn-sm"
              title="Rename this dropdown"
              aria-label="Rename this dropdown"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-slate-300"
                  checked={showStored}
                  onChange={(e) => setShowStored(e.target.checked)}
                />
                Show stored values
              </label>
              <button
                onClick={() => {
                  setOptions([...options, {
                    value: '', label: '', color: SWATCHES[options.length % SWATCHES.length],
                    isActive: true, isDefault: false,
                  }]);
                  setDirty(true);
                }}
                className="btn-secondary btn-sm"
              >
                <Plus className="h-3.5 w-3.5" /> Add option
              </button>
              {picked.size > 0 && (
                <button
                  onClick={() => setClearing(true)}
                  className="btn-secondary btn-sm text-red-600"
                  title="Remove the ticked options"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove {picked.size}
                </button>
              )}
              <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm">
                {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
              </button>
            </div>
          </div>

          {current && (current.usedBy.length > 0 || current.usedInCode) && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/40">
              <span className="text-2xs text-muted">Used by</span>
              {current.usedInCode && (
                <span className="rounded bg-white px-1.5 py-0.5 text-2xs dark:bg-slate-900">
                  iPropy itself — {current.usedInCode}
                </span>
              )}
              {current.usedBy.map((u) => (
                <span key={`${u.module}.${u.field}`} className="rounded bg-white px-1.5 py-0.5 text-2xs dark:bg-slate-900">
                  {u.moduleLabel} → {u.fieldLabel}
                </span>
              ))}
            </div>
          )}

          {/* Only for a list long enough that ticking one at a time is a chore,
              and only over options that already exist — a row you have just
              added has nothing to remove. */}
          {options.filter((o) => o.previousValue).length > 3 && (
            <label className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs text-muted dark:border-slate-800 dark:bg-slate-800/40">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={picked.size > 0 && picked.size === options.filter((o) => o.previousValue).length}
                ref={(el) => {
                  // Some ticked, not all: the box says "partly" rather than
                  // claiming either.
                  if (el) el.indeterminate = picked.size > 0
                    && picked.size < options.filter((o) => o.previousValue).length;
                }}
                onChange={(e) => setPicked(e.target.checked
                  ? new Set(options.filter((o) => o.previousValue).map((o) => o.previousValue!))
                  : new Set())}
              />
              {picked.size > 0 ? `${picked.size} selected` : 'Select all'}
            </label>
          )}

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {options.map((option, index) => (
              <div
                key={option.previousValue ?? `new-${index}`}
                className={cn(
                  'transition-colors',
                  dragIndex === index && 'bg-brand-50/60 dark:bg-brand-950/40',
                  !option.isActive && 'opacity-60',
                )}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) moveTo(dragIndex, index); setDragIndex(null); }}
              >
                {/* One line — the decision and the dressing together: select,
                    reorder, name, colour, preview, default, active, delete.
                    Wrapping stays inside the row, so the colour never drops
                    onto a second indented line under the name. */}
                <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                  {/* Only a saved option can be removed; an unsaved new row is
                      removed by clearing what you typed. */}
                  {option.previousValue ? (
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0"
                      checked={picked.has(option.previousValue)}
                      onChange={(e) => setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(option.previousValue!);
                        else next.delete(option.previousValue!);
                        return next;
                      })}
                      aria-label={`Select ${option.label || option.value}`}
                    />
                  ) : <span className="w-3.5 shrink-0" />}

                  <div
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragEnd={() => setDragIndex(null)}
                    className="shrink-0 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing"
                    title="Drag to reorder"
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </div>

                  {/* Arrows as well as drag: reordering has to work on a phone,
                      and HTML5 drag events do not fire from touch. */}
                  <div className="flex shrink-0 flex-col">
                    <button
                      onClick={() => moveTo(index, index - 1)}
                      disabled={index === 0}
                      className="btn-ghost p-0.5 disabled:opacity-25"
                      aria-label={`Move ${option.label || 'option'} up`}
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => moveTo(index, index + 1)}
                      disabled={index === options.length - 1}
                      className="btn-ghost p-0.5 disabled:opacity-25"
                      aria-label={`Move ${option.label || 'option'} down`}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>

                  {/*
                    One box, not two — and sized to its job. `flex-1` stretched
                    the name to swallow the whole panel; a fixed max keeps the
                    line compact and lets the colour sit beside the name.

                    There used to be a second "stored value" field beside this
                    one, because renaming what is *written on the record* is a
                    different act from renaming what is *shown*. That distinction
                    is real but it is not the admin's problem on the way past: on
                    a new option the stored value follows the name, and on an
                    existing one it stays put, which is the safe answer in both
                    cases. The rare edit is behind "Show stored values" above.
                  */}
                  <div className="relative w-full max-w-[16rem] sm:w-56">
                    <input
                      className="input w-full py-1.5 text-sm"
                      placeholder="Option name"
                      aria-label="Option name"
                      value={option.label}
                      onChange={(e) => {
                        const label = e.target.value;
                        // A new row's stored value follows its name. An existing
                        // row's never does — changing that rewrites every record
                        // holding it, and renaming a label should stay free.
                        const linked = !option.previousValue;
                        update(index, { label, ...(linked ? { value: label } : {}) });
                      }}
                    />
                    {option.usedInCode && (
                      <span
                        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
                        title={`The app looks for this option by name — it drives ${option.usedInCode}. Renaming what is stored will stop that working, with no error anywhere.`}
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </div>

                  {/* The colour and its preview, right beside the name they
                      dress. The rare stored-value edit joins the line only
                      when asked for above. */}
                  {showStored && (
                    <input
                      className={cn(
                        'input w-40 py-1 font-mono text-xs',
                        option.usedInCode && option.previousValue !== option.value
                          && 'border-amber-400 focus:border-amber-500 focus:ring-amber-500',
                      )}
                      placeholder="Stored value"
                      aria-label="Stored value"
                      value={option.value}
                      onChange={(e) => update(index, { value: e.target.value })}
                      title={option.previousValue && option.previousValue !== option.value
                        ? `Saving moves every record from "${option.previousValue}" to "${option.value}"`
                        : 'What gets written on the record'}
                    />
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        onClick={() => update(index, { color: c })}
                        className={cn(
                          'h-4 w-4 rounded-full transition-transform hover:scale-125',
                          option.color === c && 'ring-2 ring-slate-400 ring-offset-1 dark:ring-offset-slate-900',
                        )}
                        style={{ backgroundColor: c }}
                        title={c}
                        aria-label={`Colour ${c}`}
                      />
                    ))}
                    <input
                      type="color"
                      value={option.color ?? '#64748b'}
                      onChange={(e) => update(index, { color: e.target.value })}
                      className="h-4 w-4 cursor-pointer rounded-full border-0 bg-transparent p-0"
                      title="Any other colour"
                      aria-label="Pick any colour"
                    />
                  </div>
                  <Badge color={option.color} className="hidden sm:inline-flex">
                    {option.label || 'Preview'}
                  </Badge>

                  <button
                    onClick={() => {
                      setOptions((prev) => prev.map((o, i) => ({
                        ...o, isDefault: i === index && !option.isDefault,
                      })));
                      setDirty(true);
                    }}
                    className={cn(
                      'ml-auto shrink-0 transition-colors',
                      option.isDefault ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500',
                    )}
                    title={option.isDefault ? 'This is the default for new records' : 'Make this the default'}
                    aria-label={option.isDefault ? 'Default option' : 'Make default'}
                  >
                    <Star className={cn('h-3.5 w-3.5', option.isDefault && 'fill-current')} />
                  </button>
                  <Toggle
                    checked={option.isActive}
                    onChange={(v) => update(index, { isActive: v })}
                    label="Active"
                  />
                  <button
                    onClick={() => {
                      // A row that was never saved has no records to worry about.
                      if (!option.previousValue) {
                        setOptions(options.filter((_, i) => i !== index));
                        setDirty(true);
                        return;
                      }
                      if (dirty) {
                        toast.error('Save your other changes first', 'Deleting an option touches records, so it runs on its own.');
                        return;
                      }
                      setDeleting(option);
                    }}
                    className="shrink-0 text-slate-300 hover:text-red-500"
                    title="Delete this option"
                    aria-label={`Delete ${option.label || 'option'}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {options.length === 0 && (
            <p className="py-10 text-center text-sm text-muted">No options yet</p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 px-4 py-2 text-2xs text-muted dark:border-slate-800">
            <span>
              <strong className="font-medium">Active off</strong> keeps the option on records that already
              have it but stops it being chosen again. <strong className="font-medium">Delete</strong> removes
              it for good, and asks what to do with any records still using it.
            </span>
            {current?.canDelete && (
              <button
                onClick={() => void deleteWholeList(current.name, current.label, refresh)}
                className="ml-auto text-red-500 hover:underline"
              >
                Delete this dropdown
              </button>
            )}
          </div>
        </div>
      </div>

      <NewPicklistDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(name) => { setSelected(name); refresh(); }}
      />

      <RenamePicklistDialog
        open={renaming}
        name={current?.name ?? ''}
        label={current?.label ?? ''}
        onClose={() => setRenaming(false)}
        onSaved={refresh}
      />

      <DeleteOptionDialog
        picklist={selected}
        picklistLabel={current?.label ?? selected}
        option={deleting}
        others={options.filter((o) => o.value !== deleting?.value && o.previousValue)}
        onClose={() => setDeleting(null)}
        onDeleted={(deletedValue) => {
          // Removed here as well as on the server. `refresh()` only invalidates
          // the query; until the refetch lands the editor still holds the row,
          // and pressing Save in that window used to re-create the option and
          // wipe its tombstone.
          setOptions((prev) => prev.filter((o) => o.value !== deletedValue));
          refresh();
        }}
      />

      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        onConfirm={async () => {
          const values = [...picked];
          let removed = 0;
          const refused: string[] = [];
          // One at a time, because each still has to answer "what happens to the
          // records holding this value?" — and one refusal must not abandon the
          // rest of the batch.
          for (const value of values) {
            try {
               
              await api.deletePicklistValue(selected, value, { clear: true });
              removed += 1;
            } catch {
              refused.push(value);
            }
          }
          setPicked(new Set());
          if (removed) {
            toast.success(
              `Removed ${removed} option${removed === 1 ? '' : 's'}`,
              refused.length ? `${refused.length} could not be removed.` : undefined,
            );
          }
          if (refused.length) {
            toast.error(
              `Could not remove ${refused.length} option${refused.length === 1 ? '' : 's'}`,
              `${refused.slice(0, 3).join(', ')}${refused.length > 3 ? '…' : ''} — records still use `
              + 'them and the field they are on cannot be left empty.',
            );
          }
          refresh();
        }}
        title={`Remove ${picked.size} option${picked.size === 1 ? '' : 's'} from “${current?.label ?? selected}”?`}
        body={(
          <>
            <p>
              Any record still holding one of these has that field cleared. The options you have not
              ticked are untouched.
            </p>
            <p>
              An option is refused if the field using it is required, because those records cannot be
              left empty. The rest still go.
            </p>
          </>
        )}
        confirmLabel={`Remove ${picked.size}`}
        danger
      />
    </div>
  );
}

/**
 * Delete a whole dropdown.
 *
 * Only offered when the server says nothing depends on it — no field draws its
 * options from it and iPropy does not read it by name. Twenty-five of the
 * seeded lists are in that state, left behind by the modules that were removed,
 * and tidying them up should not need a developer.
 */
async function deleteWholeList(
  name: string, label: string, refresh: () => void,
): Promise<void> {
   
  if (!window.confirm(
    `Delete the "${label}" dropdown and all of its options?\n\n`
    + 'Nothing currently uses it. This cannot be undone, and it stays deleted through restarts.',
  )) return;
  try {
    await api.deletePicklist(name);
    toast.success('Dropdown deleted', `"${label}" is gone for good.`);
    refresh();
  } catch (err) {
    toast.error('Could not delete', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function NewPicklistDialog({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (name: string) => void }): JSX.Element {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setLabel(''); }, [open]);

  const create = async (): Promise<void> => {
    const name = slug(label);
    if (!name) { toast.error('Give the dropdown a name'); return; }
    setBusy(true);
    try {
      await api.createPicklist({ name, label: label.trim(), values: [] });
      toast.success('Dropdown created', 'Add its options, then Save.');
      onCreated(name);
      onClose();
    } catch (err) {
      toast.error('Could not create', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open} onClose={onClose} title="New dropdown" size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void create()} disabled={busy || !label.trim()}>
            {busy && <Spinner />} Create
          </button>
        </>
      }
    >
      <label className="label" htmlFor="new-picklist-label">Name</label>
      <input
        id="new-picklist-label"
        className="input"
        placeholder="e.g. Referral Source"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) void create(); }}
      />
      <p className="mt-1.5 text-2xs text-muted">
        Stored as <span className="font-mono">{slug(label) || '…'}</span>. Once it exists you can point any
        dropdown field at it in Admin → Modules &amp; Fields.
      </p>
    </Modal>
  );
}

function RenamePicklistDialog({
  open, name, label, onClose, onSaved,
}: { open: boolean; name: string; label: string; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [next, setNext] = useState(label);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) setNext(label); }, [open, label]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.renamePicklist(name, next.trim());
      toast.success('Renamed');
      onSaved();
      onClose();
    } catch (err) {
      toast.error('Could not rename', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open} onClose={onClose} title="Rename dropdown" size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void save()} disabled={busy || !next.trim()}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <label className="label" htmlFor="rename-picklist">Name</label>
      <input
        id="rename-picklist"
        className="input"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && next.trim()) void save(); }}
      />
      <p className="mt-1.5 text-2xs text-muted">
        This is the name you see here. The stored key <span className="font-mono">{name}</span> and every
        option stay exactly as they are.
      </p>
    </Modal>
  );
}

/**
 * Deleting one option.
 *
 * Opens by asking the server how many records hold it, because the honest
 * answer changes what the dialog offers: nothing to move means a plain
 * confirm, and a thousand leads means choosing where those leads go before
 * anything is deleted.
 */
function DeleteOptionDialog({
  picklist, picklistLabel, option, others, onClose, onDeleted,
}: {
  picklist: string;
  picklistLabel: string;
  option: Option | null;
  others: Option[];
  onClose: () => void;
  onDeleted: (deletedValue: string) => void;
}): JSX.Element {
  const [usage, setUsage] = useState<
    {
      total: number;
      byField: { module: string; field: string; count: number }[];
      canClear: boolean;
      usedInCode?: string | null;
    } | null
  >(null);
  const [replaceWith, setReplaceWith] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!option) { setUsage(null); return; }
    setReplaceWith('');
    let live = true;
    void api.picklistValueUsage(picklist, option.value)
      .then((u) => {
        if (!live) return;
        setUsage(u);
        // A required field cannot be emptied, so start on a real replacement
        // rather than an option the server is going to refuse.
        if (u.total > 0 && !u.canClear) {
          setReplaceWith(others.find((o) => o.value !== option.value)?.value ?? '');
        }
      })
      .catch(() => { if (live) setUsage({ total: 0, byField: [], canClear: true }); });
    return () => { live = false; };
  }, [option, picklist]);

  const remove = async (): Promise<void> => {
    if (!option) return;
    setBusy(true);
    try {
      const result = await api.deletePicklistValue(picklist, option.value, {
        ...(replaceWith ? { replaceWith } : {}),
        ...(usage && usage.total > 0 && !replaceWith ? { clear: true } : {}),
      });
      toast.success(
        'Option deleted',
        result.movedRecords
          ? `${result.movedRecords} record${result.movedRecords === 1 ? '' : 's'} ${replaceWith ? `moved to "${replaceWith}"` : 'had the field cleared'}.`
          : `"${option.label}" is gone for good.`,
      );
      onDeleted(option.value);
      onClose();
    } catch (err) {
      toast.error(
        'Could not delete',
        err instanceof ApiError ? err.message : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(option)} onClose={onClose} title={`Delete "${option?.label ?? ''}"`} size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-danger" onClick={() => void remove()} disabled={busy || !usage}>
            {busy && <Spinner />}
            {usage && usage.total > 0 ? `Delete and update ${usage.total}` : 'Delete'}
          </button>
        </>
      }
    >
      {/* Renaming and deleting move every record and every saved filter. What
          they cannot move is a query in the application that matches on this
          exact word, and a few options have those. Said plainly, before the
          button, rather than discovered later as "the website went blank". */}
      {usage?.usedInCode && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/40">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-amber-900 dark:text-amber-200">
            <strong className="font-medium">The app looks for this option by name.</strong>{' '}
            It drives {usage.usedInCode}. Removing or renaming it will stop that working, and
            nothing will report an error — switching it to <strong className="font-medium">inactive</strong>{' '}
            instead keeps it working while hiding it from new records.
          </p>
        </div>
      )}

      {!usage ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Checking which records use it…
        </div>
      ) : usage.total === 0 ? (
        <p className="text-sm text-muted">
          Nothing uses this option, so it will be removed from {picklistLabel} for good — including
          across restarts and redeploys.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            <strong className="font-medium tnum">{usage.total}</strong> record{usage.total === 1 ? '' : 's'} still
            {usage.total === 1 ? ' has' : ' have'} this value
            {usage.byField.length > 0 && (
              <span className="text-muted">
                {' '}({usage.byField.map((f) => `${f.count} in ${f.field}`).join(', ')})
              </span>
            )}.
          </p>
          <div>
            <label className="label" htmlFor="replace-with">Change those records to</label>
            <select
              id="replace-with"
              className="input"
              value={replaceWith}
              onChange={(e) => setReplaceWith(e.target.value)}
            >
              {usage.canClear && <option value="">Leave the field empty</option>}
              {others.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <p className="text-2xs text-muted">
            Saved views, dashboard filters and workflow rules that mention this value are updated to
            match. If you would rather keep the history exactly as it is, close this and switch the
            option to <strong className="font-medium">inactive</strong> instead — it stays on old
            records and stops being offered on new ones.
          </p>
        </div>
      )}
    </Modal>
  );
}
