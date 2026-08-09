/**
 * The master for list view tabs — "All Records", "Open Leads", "Hot Leads".
 *
 * Those tabs are the first thing anyone sees on a list and the seeded set is a
 * guess about how this desk works. This is where that guess gets corrected:
 * rename, reorder, retune the filter, switch one off for a month, or add one of
 * your own.
 *
 * Deactivating rather than deleting is the default action on purpose. Someone
 * who wants a tab off the strip for a while should not have to destroy the
 * filter they spent time building, and a delete that loses work is a reason
 * people stop customising at all.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomView, FilterGroup, ModuleMeta } from '@ipropy/shared';
import {
  ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripVertical, Lock, Plus, Trash2,
} from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { FilterBuilder, countConditions } from '../../components/FilterBuilder';
import {
  Badge, Card, ConfirmDialog, EmptyState, Input, Modal, Select, Spinner, Textarea, Toggle,
} from '../../components/ui';

const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] };

type AdminView = CustomView & { isActive?: boolean; count?: number };

/** An empty tab, with an id of '' so the editor knows it is creating. */
function blankView(module: string): AdminView {
  return {
    id: '', module, name: '', description: null,
    isDefault: false, isPublic: true, isSystem: false, ownerId: null,
    columns: [], filter: EMPTY_FILTER, sortBy: null, sortDir: 'desc',
    displayMode: 'table', groupBy: null, showMetrics: false, sequence: 0,
    isActive: true,
  };
}

export default function ViewsAdmin(): JSX.Element {
  const [moduleName, setModuleName] = useState('leads');
  const [editing, setEditing] = useState<AdminView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminView | null>(null);
  const client = useQueryClient();

  const { data: modules } = useQuery({ queryKey: ['modules'], queryFn: () => api.modules() });

  const { data: views, isLoading } = useQuery({
    queryKey: ['admin-views', moduleName],
    queryFn: () => api.views(moduleName, false, true) as Promise<AdminView[]>,
  });

  const { data: meta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName),
  });

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['admin-views', moduleName] });
    // The list screen reads the same views; without this the strip does not
    // change until a reload.
    void client.invalidateQueries({ queryKey: ['views', moduleName] });
  };

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.updateView(moduleName, id, { isActive }),
    onSuccess: refresh,
    onError: (err: Error) => toast.error('Could not update the tab', err.message),
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.reorderViews(moduleName, ids),
    onSuccess: refresh,
    onError: (err: Error) => toast.error('Could not reorder', err.message),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateView(moduleName, id),
    onSuccess: () => { refresh(); toast.success('Copied'); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteView(moduleName, id),
    onSuccess: () => { refresh(); toast.success('Tab deleted'); },
    onError: (err: Error) => toast.error('Could not delete', err.message),
  });

  const move = (index: number, direction: -1 | 1): void => {
    if (!views) return;
    const next = [...views];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(next.map((v) => v.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">List view tabs</h2>
          <p className="text-sm text-muted">
            The tabs across the top of every list. Rename them, reorder them, change what they
            filter, or switch one off without losing it.
          </p>
        </div>
        <button
          onClick={() => setEditing(blankView(moduleName))}
          className="btn-primary btn-sm"
        >
          <Plus className="h-3.5 w-3.5" /> New tab
        </button>
      </div>

      <div className="max-w-xs">
        <label className="label">Module</label>
        <Select
          value={moduleName}
          onChange={setModuleName}
          options={(modules ?? []).map((m) => ({ value: m.name, label: m.label }))}
        />
      </div>

      {isLoading && <Spinner className="mx-auto mt-8 h-6 w-6" />}

      {!isLoading && !views?.length && (
        <EmptyState title="No tabs yet" body="Create one to give this list a starting filter." />
      )}

      <div className="space-y-2">
        {views?.map((view, index) => (
          <Card key={view.id} className={cn('p-3', view.isActive === false && 'opacity-60')}>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex shrink-0 flex-col">
                <button
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="btn-ghost p-0.5 disabled:opacity-25"
                  title="Move up"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => move(index, 1)}
                  disabled={index === (views.length - 1)}
                  className="btn-ghost p-0.5 disabled:opacity-25"
                  title="Move down"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>

              <GripVertical className="hidden h-4 w-4 shrink-0 text-slate-300 sm:block dark:text-slate-700" />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button onClick={() => setEditing(view)} className="font-medium hover:underline">
                    {view.name}
                  </button>
                  {view.isSystem && (
                    <Badge color="#64748b">
                      <Lock className="mr-0.5 inline h-2.5 w-2.5" /> built in
                    </Badge>
                  )}
                  {view.isDefault && <Badge color="#0891b2">default</Badge>}
                  {view.displayMode === 'kanban' && <Badge color="#7c3aed">board</Badge>}
                </div>
                <p className="text-2xs text-muted">
                  {countConditions(view.filter as FilterGroup)
                    ? `${countConditions(view.filter as FilterGroup)} filter condition${countConditions(view.filter as FilterGroup) === 1 ? '' : 's'}`
                    : 'No filter — shows everything'}
                  {view.columns?.length ? ` · ${view.columns.length} columns` : ''}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => toggleActive.mutate({ id: view.id, isActive: view.isActive === false })}
                  className="btn-ghost p-1.5 text-muted"
                  title={view.isActive === false ? 'Show this tab' : 'Hide this tab'}
                >
                  {view.isActive === false ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <button
                  onClick={() => duplicate.mutate(view.id)}
                  className="btn-ghost p-1.5 text-muted"
                  title="Duplicate"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setConfirmDelete(view)}
                  className="btn-ghost p-1.5 text-muted hover:text-red-600"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {editing && meta && (
        <ViewEditor
          view={editing}
          module={meta}
          moduleName={moduleName}
          onClose={() => setEditing(null)}
          onSaved={() => { refresh(); setEditing(null); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) remove.mutate(confirmDelete.id); setConfirmDelete(null); }}
        title={`Delete "${confirmDelete?.name}"?`}
        body={
          confirmDelete?.isSystem
            ? 'This is a built-in tab. Re-running the seed restores it, but any changes you made to it are lost. Hiding it instead keeps the filter.'
            : 'The tab and its filter are removed. No records are affected.'
        }
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function ViewEditor({
  view, module, moduleName, onClose, onSaved,
}: {
  view: AdminView;
  module: ModuleMeta;
  moduleName: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState(view.name);
  const [description, setDescription] = useState(view.description ?? '');
  const [filter, setFilter] = useState<FilterGroup>((view.filter as FilterGroup) ?? EMPTY_FILTER);
  const [columns, setColumns] = useState<string[]>(view.columns ?? []);
  const [sortBy, setSortBy] = useState(view.sortBy ?? '');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(view.sortDir ?? 'desc');
  const [displayMode, setDisplayMode] = useState(view.displayMode ?? 'table');
  const [groupBy, setGroupBy] = useState(view.groupBy ?? '');
  const [showMetrics, setShowMetrics] = useState(Boolean(view.showMetrics));

  useEffect(() => { setName(view.name); }, [view.id]);

  const listable = useMemo(
    () => module.fields.filter((f) => f.isActive && f.displayType !== 'hidden'),
    [module.fields],
  );

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
        showMetrics,
        isPublic: true,
      };
      return view.id
        ? api.updateView(moduleName, view.id, payload)
        : api.createView(moduleName, payload);
    },
    onSuccess: () => { toast.success('Tab saved'); onSaved(); },
    onError: (err: Error) => toast.error('Could not save', err.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={view.id ? `Edit "${view.name}"` : 'New tab'}
      size="xl"
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="btn-primary">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Tab name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hot Leads" />
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
          <label className="label">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What this tab is for — shown as a tooltip."
          />
        </div>

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
            Leave empty to show every record the user is allowed to see.
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
          <label className="label">Columns</label>
          <p className="mb-2 text-2xs text-muted">
            Tap to include. Order follows the order you pick them.
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

        <Toggle
          checked={showMetrics}
          onChange={setShowMetrics}
          label="Show a record count on the tab"
        />
      </div>
    </Modal>
  );
}
