import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { ConfirmDialog, EmptyState, Modal, Spinner } from '../../components/ui';

/**
 * Reusable email copy.
 *
 * There was a WhatsApp tab beside this one until 17 September 2026, when
 * WhatsApp was removed from the CRM on the owner's instruction.
 */
type EmailTemplate = { id: string; name: string; subject: string; body_html: string; category: string };

const cleanName = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export default function TemplatesAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [removing, setRemoving] = useState<EmailTemplate | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', subject: '', body: '', category: 'general' });
  const { data: templates, isLoading } = useQuery({ queryKey: ['email-templates'], queryFn: api.emailTemplates });

  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['email-templates'] }); };
  const save = useMutation({
    mutationFn: () => api.createEmailTemplate({ name: cleanName(draft.name), subject: draft.subject, bodyHtml: draft.body, category: draft.category.toLowerCase() }),
    onSuccess: () => { toast.success(editing ? 'Template updated' : 'Template created'); setOpen(false); setEditing(null); refresh(); },
    onError: (error: Error) => toast.error('Could not save template', error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteEmailTemplate(id),
    onSuccess: () => { toast.success('Template removed'); setRemoving(null); refresh(); },
    onError: (error: Error) => toast.error('Could not remove template', error.message),
  });
  const start = (template?: EmailTemplate): void => {
    setEditing(template ?? null);
    if (template) setDraft({ name: template.name, subject: template.subject, body: template.body_html, category: template.category });
    else setDraft({ name: '', subject: '', body: '', category: 'general' });
    setOpen(true);
  };
  const close = (): void => { setOpen(false); setEditing(null); };

  const list = (templates ?? []) as unknown as EmailTemplate[];

  return <div className="p-4 sm:p-6">
    <div className="mb-5 flex flex-wrap items-start gap-3">
      <div><h1 className="text-lg font-semibold tracking-tight">Email templates</h1><p className="text-sm text-muted">Write reusable emails once. They are ready in record communication screens whenever your team needs them.</p></div>
      <button className="btn-primary btn-sm ml-auto" onClick={() => start()}><Plus className="h-3.5 w-3.5" /> New template</button>
    </div>
    {isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : !list.length ? <EmptyState icon={<CopyPlus className="h-9 w-9" />} title="No email templates yet" body="Create the first reusable message for your team." action={<button className="btn-primary btn-sm" onClick={() => start()}>Create template</button>} /> : <div className="card divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">{list.map((template) => <div key={template.id} className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="font-medium">{template.name}</p><p className="truncate text-xs text-muted">{template.subject}</p></div><button className="btn-ghost p-1.5" title={`Edit ${template.name}`} onClick={() => start(template)}><Pencil className="h-3.5 w-3.5" /></button><button className="btn-ghost p-1.5 text-negative" title={`Remove ${template.name}`} onClick={() => setRemoving(template)}><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div>}
    <Modal open={open} onClose={close} title={editing ? 'Edit email template' : 'New email template'} size="lg" footer={<><button className="btn-secondary" onClick={close}>Cancel</button><button className="btn-primary" disabled={!cleanName(draft.name) || !draft.body.trim() || !draft.subject.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save template'}</button></>}>
      <div className="grid gap-4 sm:grid-cols-2"><label className="label">Template name<input className="input mt-1" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="site_visit_follow_up" /></label><label className="label">Category<select className="input mt-1" value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}><option value="general">General</option><option value="marketing">Marketing</option><option value="follow_up">Follow-up</option></select></label></div>
      <label className="label mt-4">Subject<input className="input mt-1" value={draft.subject} onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))} placeholder="A quick update for {{contact.first_name}}" /></label>
      <label className="label mt-4">Message<textarea className="input mt-1 min-h-40" value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} placeholder="Hi {{contact.first_name}}," /></label>
      <p className="mt-3 text-xs text-muted">Use merge fields such as <code>{'{{contact.first_name}}'}</code> and <code>{'{{record.unit_number}}'}</code>.</p>
    </Modal>
    <ConfirmDialog open={removing !== null} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutateAsync(removing.id)} title={`Remove “${removing?.name ?? ''}”?`} body="It will no longer appear when sending a message. Previous messages are not changed." confirmLabel="Remove template" danger />
  </div>;
}
