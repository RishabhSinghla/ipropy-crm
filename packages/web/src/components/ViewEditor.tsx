/**
 * The one editor for a saved list view.
 *
 * It used to live in Admin → List View Tabs, which is gone: curating the strip
 * for everybody was the wrong shape for a product that ships exactly two views
 * and lets each person tune them. Everything that screen did happens here, on
 * the list, next to the view being changed.
 *
 * Two rules this screen enforces, both about who a change lands on:
 *
 *  - Editing one of the two built-in views gives you your own version of it.
 *    The server does that (migration 135); this side only has to say so, and
 *    offer the way back.
 *
 *  - Sharing is per person. The switch asks who rather than meaning
 *    "everyone", and it starts off, so a view you make is yours until you say
 *    otherwise. It is hidden entirely on a built-in view: your version of
 *    "All Leads" is yours by definition and there is nothing there to share.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CustomView, FilterGroup, ModuleMeta } from '@ipropy/shared';
import { RotateCcw, Search } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { FilterBuilder } from './FilterBuilder';
import { Avatar, ConfirmDialog, Input, Modal, Select, Textarea, Toggle } from './ui';

const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] };

export type SavedView = CustomView & { isActive?: boolean; count?: number };

/** An empty view, with an id of '' so the editor knows it is creating. */
export function blankView(module: string): SavedView {
  return {
    id: '', module, name: '', description: null,
    isDefault: false, isPublic: false, isSystem: false, ownerId: null,
    columns: [], filter: EMPTY_FILTER, sortBy: null, sortDir: 'desc',
    displayMode: 'table', groupBy: null, showMetrics: false, sequence: 0,
    isActive: true, sharedWith: [],
  };
}

interface DirectoryUser { id: string; fullName: string }

export function ViewEditor({
  view, module, moduleName, onClose, onSaved,
}: {
  view: SavedView;
  module: ModuleMeta;
  moduleName: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const me = useApp((s) => s.user);
  const [name, setName] = useState(view.name);
  const [description, setDescription] = useState(view.description ?? '');
  const [filter, setFilter] = useState<FilterGroup>((view.filter as FilterGroup) ?? EMPTY_FILTER);
  const [columns, setColumns] = useState<string[]>(view.columns ?? []);
  const [sortBy, setSortBy] = useState(view.sortBy ?? '');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(view.sortDir ?? 'desc');
  const [displayMode, setDisplayMode] = useState(view.displayMode ?? 'table');
  const [groupBy, setGroupBy] = useState(view.groupBy ?? '');
  const [sharedWith, setSharedWith] = useState<string[]>(view.sharedWith ?? []);
  const [shareOn, setShareOn] = useState((view.sharedWith ?? []).length > 0);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  // A built-in view, or this person's own version of one. Either way the
  // shared-or-private question does not arise, and Reset is on offer.
  const builtIn = view.isSystem === true;

  useEffect(() => {
    setName(view.name);
    setSharedWith(view.sharedWith ?? []);
    setShareOn((view.sharedWith ?? []).length > 0);
  }, [view.id]);

  const { data: people } = useQuery({
    queryKey: ['directory'],
    queryFn: () => api.users() as Promise<unknown> as Promise<DirectoryUser[]>,
    staleTime: 5 * 60_000,
    enabled: shareOn,
  });

  /*
    Fields listed by name, A to Z.

    They arrive in `sequence` — the order an admin arranged them on the form —
    which is the right order on a form and no order at all in a list of forty
    chips you are scanning for one word. `localeCompare` rather than `<` so the
    accented and non-Latin labels this CRM carries land where a reader expects
    rather than where their code point falls.
  */
  const listable = useMemo(
    () => module.fields
      .filter((f) => f.isActive && f.displayType !== 'hidden')
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label)),
    [module.fields],
  );

  const candidates = useMemo(() => {
    const term = peopleQuery.trim().toLowerCase();
    return (people ?? [])
      .filter((u) => u.id !== me?.id)
      .filter((u) => !term || u.fullName.toLowerCase().includes(term))
      .slice()
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [people, peopleQuery, me?.id]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name,
        description: description || undefined,
        filter,
        columns,
        sortBy: sortBy || null,
        sortDir,
        displayMode,
        groupBy: displayMode === 'kanban' ? (groupBy || null) : null,
        showMetrics: false,
        // A built-in view is never shared from here: the server saves the edit
        // as this person's own copy, and a copy has nobody to share it with.
        ...(builtIn ? {} : { isPublic: false, sharedWith: shareOn ? sharedWith : [] }),
      };
      return view.id
        ? api.updateView(moduleName, view.id, payload)
        : api.createView(moduleName, payload);
    },
    onSuccess: () => {
      toast.success(
        builtIn ? 'Saved as your version of this view' : 'View saved',
        builtIn ? 'Everyone else still sees the built-in one.' : undefined,
      );
      onSaved();
    },
    onError: (err: Error) => toast.error('Could not save', err.message),
  });

  const reset = useMutation({
    mutationFn: () => api.resetView(moduleName, view.builtInId ?? view.id),
    onSuccess: () => { toast.success('Back to the built-in view'); setConfirmReset(false); onSaved(); },
    onError: (err: Error) => toast.error('Could not reset', err.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={view.id ? `Edit “${view.name}”` : 'New view'}
      size="xl"
      footer={
        <>
          {view.isOverride && (
            <button
              onClick={() => setConfirmReset(true)}
              className="btn-ghost mr-auto"
              title="Discard your version and go back to the built-in view"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset to built-in
            </button>
          )}
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="btn-primary">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {builtIn && (
          <p className="rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-xs text-brand-800 dark:border-brand-900 dark:bg-brand-950/30 dark:text-brand-200">
            This is one of the two views the CRM ships with. Saving a change here keeps it to
            your account — everyone else goes on seeing the built-in one.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="view_name">View name</label>
            <Input id="view_name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hot Leads" />
          </div>
          <div>
            <label className="label">Shows as</label>
            <Select
              value={displayMode}
              onChange={(v) => setDisplayMode(v as typeof displayMode)}
              options={[
                { value: 'table', label: 'Table' },
                { value: 'kanban', label: 'Board (grouped columns)' },
              ]}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="view_description">Description</label>
          <Textarea
            id="view_description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What this view is for — shown as a tooltip."
          />
        </div>

        {!builtIn && (
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <Toggle
              checked={shareOn}
              onChange={(on) => { setShareOn(on); if (!on) setSharedWith([]); }}
              label="Share this view with CRM users who can access this module"
            />
            {shareOn && (
              <div className="mt-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <Input
                    className="pl-8"
                    value={peopleQuery}
                    onChange={(e) => setPeopleQuery(e.target.value)}
                    placeholder="Search people…"
                    aria-label="Search people to share this view with"
                  />
                </div>
                <div className="mt-2 max-h-52 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700">
                  {candidates.length === 0 ? (
                    <p className="px-3 py-2.5 text-xs text-muted">
                      {people ? 'Nobody matches that.' : 'Loading people…'}
                    </p>
                  ) : candidates.map((u) => (
                    <label
                      key={u.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-slate-300"
                        checked={sharedWith.includes(u.id)}
                        onChange={(e) => setSharedWith((prev) => (
                          e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id)
                        ))}
                      />
                      <Avatar name={u.fullName} size={20} />
                      <span className="truncate">{u.fullName}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1.5 text-2xs text-muted">
                  {sharedWith.length
                    ? `Shared with ${sharedWith.length} ${sharedWith.length === 1 ? 'person' : 'people'}. It appears in their view list; what each of them can see inside it still follows their own permissions.`
                    : 'Nobody picked yet — this view stays yours until you choose someone.'}
                </p>
              </div>
            )}
          </div>
        )}

        {displayMode === 'kanban' && (
          <div>
            <label className="label">Group columns by</label>
            <Select
              value={groupBy}
              onChange={setGroupBy}
              placeholder={module.pipelineField ?? 'Pick a field'}
              options={listable
                .filter((f) => f.uitype === 'picklist')
                .map((f) => ({ value: f.name, label: f.label }))}
            />
          </div>
        )}

        <div>
          <label className="label">Which records appear</label>
          <FilterBuilder module={module} value={filter} onChange={setFilter} />
          <p className="mt-1 text-2xs text-muted">
            Leave empty to show every record you are allowed to see.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Sort by</label>
            <Select
              value={sortBy}
              onChange={setSortBy}
              placeholder="Most recently updated"
              options={listable.map((f) => ({ value: f.name, label: f.label }))}
            />
          </div>
          <div>
            <label className="label">Direction</label>
            <Select
              value={sortDir}
              onChange={(v) => setSortDir(v as 'asc' | 'desc')}
              options={[
                { value: 'desc', label: 'Newest / highest first' },
                { value: 'asc', label: 'Oldest / lowest first' },
              ]}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <label className="label mb-0">Columns</label>
            <div className="flex items-baseline gap-2">
              {columns.length > 0 && <span className="text-2xs text-muted tnum">{columns.length} picked</span>}
              <button
                type="button"
                className="text-2xs text-brand-700 hover:underline dark:text-brand-300"
                onClick={() => setColumns([])}
              >
                Show all
              </button>
            </div>
          </div>
          <p className="mb-2 text-2xs text-muted">
            {columns.length
              ? 'Tap to include. Order follows the order you pick them.'
              : 'Nothing picked, so every column shows — including any field added later. Tap one to narrow it down.'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {listable.map((f) => {
              const position = columns.indexOf(f.name);
              const picked = position >= 0;
              return (
                <button
                  key={f.name}
                  type="button"
                  onClick={() => setColumns((prev) => (
                    picked ? prev.filter((c) => c !== f.name) : [...prev, f.name]
                  ))}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    picked
                      ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                      : 'border-slate-200 text-muted hover:border-slate-300 dark:border-slate-700',
                  )}
                >
                  {picked && <span className="mr-1 tnum">{position + 1}</span>}
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => reset.mutate()}
        title="Go back to the built-in view?"
        body="Your version of this view is discarded and you see the one the CRM ships with. Anything you saved here is lost."
        confirmLabel="Reset"
        danger
      />
    </Modal>
  );
}
