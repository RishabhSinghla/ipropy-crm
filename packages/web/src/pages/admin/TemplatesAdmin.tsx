import { type JSX, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyPlus, Mail, MessageCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { ConfirmDialog, EmptyState, Modal, Spinner } from '../../components/ui';

type Channel = 'whatsapp' | 'email';
type WhatsAppTemplate = { id: string; name: string; language: string; category: string; status: string; body_text: string; header_text?: string | null; footer_text?: string | null };
type EmailTemplate = { id: string; name: string; subject: string; body_html: string; category: string };
type Template = WhatsAppTemplate | EmailTemplate;

const cleanName = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export default function TemplatesAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [editing, setEditing] = useState<Template | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', subject: '', body: '', category: 'UTILITY', header: '', footer: '' });
  const { data: whatsapp, isLoading: loadingWhatsapp } = useQuery({ queryKey: ['wa-templates'], queryFn: api.whatsappTemplates });
  const { data: email, isLoading: loadingEmail } = useQuery({ queryKey: ['email-templates'], queryFn: api.emailTemplates });
  const templates = (channel === 'whatsapp' ? whatsapp : email) as Template[] | undefined;
  const isLoading = channel === 'whatsapp' ? loadingWhatsapp : loadingEmail;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['wa-templates'] });
    void queryClient.invalidateQueries({ queryKey: ['email-templates'] });
  };
  const save = useMutation({
    mutationFn: () => channel === 'whatsapp'
      ? api.createWhatsappTemplate({ name: cleanName(draft.name), language: 'en', category: draft.category, bodyText: draft.body, headerText: draft.header || null, headerFormat: draft.header ? 'TEXT' : null, footerText: draft.footer || null })
      : api.createEmailTemplate({ name: cleanName(draft.name), subject: draft.subject, bodyHtml: draft.body, category: draft.category.toLowerCase() }),
    onSuccess: () => { toast.success(editing ? 'Template updated' : 'Template created'); setOpen(false); setEditing(null); refresh(); },
    onError: (error: Error) => toast.error('Could not save template', error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => channel === 'whatsapp' ? api.deleteWhatsappTemplate(id) : api.deleteEmailTemplate(id),
    onSuccess: () => { toast.success('Template removed'); setRemoving(null); refresh(); },
    onError: (error: Error) => toast.error('Could not remove template', error.message),
  });
  const heading = useMemo(() => channel === 'whatsapp' ? 'WhatsApp' : 'Email', [channel]);
  const start = (template?: Template): void => {
    setEditing(template ?? null);
    if (template && channel === 'whatsapp') {
      const item = template as WhatsAppTemplate;
      setDraft({ name: item.name, subject: '', body: item.body_text, category: item.category, header: item.header_text ?? '', footer: item.footer_text ?? '' });
    } else if (template) {
      const item = template as EmailTemplate;
      setDraft({ name: item.name, subject: item.subject, body: item.body_html, category: item.category, header: '', footer: '' });
    } else setDraft({ name: '', subject: '', body: '', category: channel === 'whatsapp' ? 'UTILITY' : 'general', header: '', footer: '' });
    setOpen(true);
  };
  const close = (): void => { setOpen(false); setEditing(null); };

  return <div className="p-4 sm:p-6">
    <div className="mb-5 flex flex-wrap items-start gap-3">
      <div><h1 className="text-lg font-semibold tracking-tight">Message templates</h1><p className="text-sm text-muted">Write approved, reusable messages once. They are ready in record communication screens whenever your team needs them.</p></div>
      <button className="btn-primary btn-sm ml-auto" onClick={() => start()}><Plus className="h-3.5 w-3.5" /> New template</button>
    </div>
    <div className="mb-5 flex gap-2 border-b border-slate-200 dark:border-slate-800">
      {([{ key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle }, { key: 'email', label: 'Email', icon: Mail }] as const).map(({ key, label, icon: Icon }) => <button key={key} onClick={() => setChannel(key)} className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${channel === key ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-muted'}`}><Icon className="h-4 w-4" />{label}</button>)}
    </div>
    {isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : !templates?.length ? <EmptyState icon={<CopyPlus className="h-9 w-9" />} title={`No ${heading} templates yet`} body="Create the first reusable message for your team." action={<button className="btn-primary btn-sm" onClick={() => start()}>Create template</button>} /> : <div className="card divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">{templates.map((template) => <div key={template.id} className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><p className="font-medium">{template.name}</p><p className="truncate text-xs text-muted">{channel === 'whatsapp' ? (template as WhatsAppTemplate).body_text : (template as EmailTemplate).subject}</p></div>{channel === 'whatsapp' && <span className="badge-neutral text-2xs">{(template as WhatsAppTemplate).status}</span>}<button className="btn-ghost p-1.5" title={`Edit ${template.name}`} onClick={() => start(template)}><Pencil className="h-3.5 w-3.5" /></button><button className="btn-ghost p-1.5 text-negative" title={`Remove ${template.name}`} onClick={() => setRemoving(template)}><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div>}
    <Modal open={open} onClose={close} title={editing ? `Edit ${heading} template` : `New ${heading} template`} size="lg" footer={<><button className="btn-secondary" onClick={close}>Cancel</button><button className="btn-primary" disabled={!cleanName(draft.name) || !draft.body.trim() || (channel === 'email' && !draft.subject.trim()) || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save template'}</button></>}>
      <div className="grid gap-4 sm:grid-cols-2"><label className="label">Template name<input className="input mt-1" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="site_visit_follow_up" /></label><label className="label">Category<select className="input mt-1" value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}>{channel === 'whatsapp' ? <><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></> : <><option value="general">General</option><option value="marketing">Marketing</option><option value="follow_up">Follow-up</option></>}</select></label></div>
      {channel === 'email' && <label className="label mt-4">Subject<input className="input mt-1" value={draft.subject} onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))} placeholder="A quick update for {{contact.first_name}}" /></label>}
      {channel === 'whatsapp' && <><label className="label mt-4">Header <span className="text-muted">(optional)</span><input className="input mt-1" value={draft.header} onChange={(e) => setDraft((d) => ({ ...d, header: e.target.value }))} /></label></>}
      <label className="label mt-4">Message<textarea className="input mt-1 min-h-40" value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} placeholder="Hi {{contact.first_name}}," /></label>
      {channel === 'whatsapp' && <label className="label mt-4">Footer <span className="text-muted">(optional)</span><input className="input mt-1" value={draft.footer} onChange={(e) => setDraft((d) => ({ ...d, footer: e.target.value }))} /></label>}
      <p className="mt-3 text-xs text-muted">Use merge fields such as <code>{'{{contact.first_name}}'}</code> and <code>{'{{record.unit_number}}'}</code>. WhatsApp templates still need Meta approval before they can be sent outside a customer&apos;s 24-hour reply window.</p>
    </Modal>
    <ConfirmDialog open={removing !== null} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutateAsync(removing.id)} title={`Remove “${removing?.name ?? ''}”?`} body="It will no longer appear when sending a message. Previous messages are not changed." confirmLabel="Remove template" danger />
  </div>;
}
