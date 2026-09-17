import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { ConfirmDialog, EmptyState, Modal, Spinner } from '../../components/ui';

type TagRow = { id: string; name: string; color: string; modules: string[]; usage_count: number };

/**
 * An empty `modules` is a value, not a blank: it means "offer this everywhere".
 * That is what every tag carried before the choice existed, so the screen says
 * so in words rather than showing nothing and letting it read as unset.
 */
const scopeLabel = (modules: string[], labels: Map<string, string>): string =>
  modules.length ? modules.map((m) => labels.get(m) ?? m).join(' & ') : 'All modules';

export default function TagsAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  // No module: the admin screen manages the whole vocabulary, including tags
  // narrowed to a module it is not currently looking at.
  const { data: tags, isLoading } = useQuery({ queryKey: ['tags'], queryFn: () => api.tags() });
  const { data: modules } = useQuery({ queryKey: ['modules'], queryFn: () => api.modules() });
  const entityModules = (modules ?? []).filter((m) => m.isEntity);
  const moduleLabels = new Map(entityModules.map((m) => [m.name, m.label]));
  const [editing, setEditing] = useState<TagRow | null>(null);
  const [draft, setDraft] = useState<{ name: string; color: string; modules: string[] }>({ name: '', color: '#2563eb', modules: [] });
  const [editorOpen, setEditorOpen] = useState(false);
  const [removing, setRemoving] = useState<TagRow | null>(null);
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['tags'] }); };

  const save = useMutation({
    mutationFn: () => editing
      ? api.updateTag(editing.id, draft)
      : api.createTag(draft),
    onSuccess: () => {
      toast.success(editing ? 'Tag updated' : 'Tag created');
      setEditing(null);
      setEditorOpen(false);
      setDraft({ name: '', color: '#2563eb', modules: [] });
      refresh();
    },
    onError: (error: Error) => toast.error('Could not save tag', error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTag(id),
    onSuccess: () => { toast.success('Tag deleted'); setRemoving(null); refresh(); },
    onError: (error: Error) => toast.error('Could not delete tag', error.message),
  });
  const closeEditor = (): void => { setEditing(null); setEditorOpen(false); setDraft({ name: '', color: '#2563eb', modules: [] }); };
  const openCreate = (): void => { setEditing(null); setDraft({ name: '', color: '#2563eb', modules: [] }); setEditorOpen(true); };
  const openEdit = (tag: TagRow): void => { setEditing(tag); setDraft({ name: tag.name, color: tag.color, modules: tag.modules ?? [] }); setEditorOpen(true); };
  const toggleModule = (name: string): void => setDraft((value) => ({
    ...value,
    modules: value.modules.includes(name)
      ? value.modules.filter((m) => m !== name)
      : [...value.modules, name],
  }));

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Tags</h1>
          <p className="text-sm text-muted">Tags group records in list views and dashboard filters. Each tag can belong to one module or to both — a tag left on <strong>All modules</strong> is offered everywhere.</p>
        </div>
        <button className="btn-primary btn-sm ml-auto" onClick={openCreate}><Plus className="h-3.5 w-3.5" /> New tag</button>
      </div>

      {isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : !(tags?.length) ? (
        <EmptyState icon={<Tag className="h-9 w-9" />} title="No tags yet" body="Create tags such as Hot, VIP or Site Visit to group records across the CRM." action={<button className="btn-primary btn-sm" onClick={openCreate}>Create your first tag</button>} />
      ) : (
        <div className="card divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
          {tags.map((tag) => (
            <div key={tag.id} className="flex items-center gap-3 px-4 py-3">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
              <span className="min-w-0 flex-1 font-medium">{tag.name}</span>
              <span className="badge-neutral shrink-0 text-2xs">{scopeLabel(tag.modules ?? [], moduleLabels)}</span>
              <span className="text-xs text-muted">{tag.usage_count} record{tag.usage_count === 1 ? '' : 's'}</span>
              <button className="btn-ghost p-1.5" title={`Edit ${tag.name}`} onClick={() => openEdit(tag)}><Pencil className="h-3.5 w-3.5" /></button>
              <button className="btn-ghost p-1.5 text-negative" title={`Delete ${tag.name}`} onClick={() => setRemoving(tag)}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}

      <Modal open={editorOpen} onClose={closeEditor} title={editing ? 'Edit tag' : 'New tag'} size="sm" footer={<><button className="btn-secondary" onClick={closeEditor}>Cancel</button><button className="btn-primary" disabled={!draft.name.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save tag'}</button></>}>
        <label className="label">Tag name<input className="input mt-1" value={draft.name} maxLength={40} autoFocus onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} placeholder="e.g. VIP" /></label>
        <label className="label mt-4 flex items-center gap-3">Colour<input type="color" value={draft.color} onChange={(event) => setDraft((value) => ({ ...value, color: event.target.value }))} className="h-9 w-12 cursor-pointer rounded border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900" /><span className="text-xs text-muted">{draft.color}</span></label>

        <fieldset className="mt-4">
          <legend className="label">Offer this tag on</legend>
          <div className="mt-1 space-y-1.5">
            {entityModules.map((m) => (
              <label key={m.name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.modules.includes(m.name)}
                  onChange={() => toggleModule(m.name)}
                />
                {m.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            {draft.modules.length
              ? `Offered on ${draft.modules.map((m) => moduleLabels.get(m) ?? m).join(' and ')} only.`
              : 'None ticked means offered everywhere — which is how every tag behaved before this choice existed.'}
          </p>
        </fieldset>
      </Modal>

      <ConfirmDialog open={removing !== null} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutateAsync(removing.id)} title={`Delete “${removing?.name ?? ''}”?`} body="This removes the tag from every record that carries it. The records themselves are not changed." confirmLabel="Delete tag" danger />
    </div>
  );
}
