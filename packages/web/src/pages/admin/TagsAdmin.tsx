import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { ConfirmDialog, EmptyState, Modal, Spinner } from '../../components/ui';

type TagRow = { id: string; name: string; color: string; usage_count: number };

export default function TagsAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { data: tags, isLoading } = useQuery({ queryKey: ['tags'], queryFn: api.tags });
  const [editing, setEditing] = useState<TagRow | null>(null);
  const [draft, setDraft] = useState({ name: '', color: '#2563eb' });
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
      setDraft({ name: '', color: '#2563eb' });
      refresh();
    },
    onError: (error: Error) => toast.error('Could not save tag', error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTag(id),
    onSuccess: () => { toast.success('Tag deleted'); setRemoving(null); refresh(); },
    onError: (error: Error) => toast.error('Could not delete tag', error.message),
  });
  const closeEditor = (): void => { setEditing(null); setEditorOpen(false); setDraft({ name: '', color: '#2563eb' }); };
  const openCreate = (): void => { setEditing(null); setDraft({ name: '', color: '#2563eb' }); setEditorOpen(true); };
  const openEdit = (tag: TagRow): void => { setEditing(tag); setDraft({ name: tag.name, color: tag.color }); setEditorOpen(true); };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Tags</h1>
          <p className="text-sm text-muted">Create one shared tag list for Leads and Inventory. Tags can be selected together and used in list views and dashboard filters.</p>
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
      </Modal>

      <ConfirmDialog open={removing !== null} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutateAsync(removing.id)} title={`Delete “${removing?.name ?? ''}”?`} body="This removes the tag from every Lead and Inventory record. The records themselves are not changed." confirmLabel="Delete tag" danger />
    </div>
  );
}
