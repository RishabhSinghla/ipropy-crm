import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  CheckCheck, CircleUser, Clock, Inbox, MessageCircle, Paperclip, Search, Send, UserPlus,
} from 'lucide-react';
import { relativeTime } from '@ipropy/shared';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { Avatar, EmptyState, Select, Skeleton, Spinner } from '../components/ui';
import { readMessageMedia, WhatsAppMedia } from '../components/WhatsAppMedia';

/**
 * The team's WhatsApp, on the business number.
 *
 * Three columns, which is the shape the owner asked for and also the shape of
 * the job: the queue on the left, the conversation in the middle, and the CRM
 * on the right so nobody has to open another tab to answer "what did they want
 * and what did we quote".
 *
 * The right-hand column shows the contact and **links** to it rather than
 * repeating it. Copying a lead's budget onto this screen would be a second
 * copy to keep in step, and the first time they disagreed nobody would know
 * which was true.
 */

type Filter = 'all' | 'mine' | 'unassigned' | 'unread' | 'open' | 'pending' | 'resolved';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All chats' },
  { value: 'mine', label: 'My chats' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'unread', label: 'Unread' },
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'resolved', label: 'Resolved' },
];

interface BizMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string | null;
  type: string;
  status: string;
  template_name: string | null;
  created_at: string;
  route: string | null;
  sent_by_name: string | null;
  error_message: string | null;
  /** Loose until `readMessageMedia` has looked at it — it is a JSONB column. */
  media: unknown;
}

export default function BusinessChats(): JSX.Element {
  const queryClient = useQueryClient();
  const me = useApp((state) => state.user);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const { data: status } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  const { data: conversations, isLoading } = useQuery({
    queryKey: ['wa-biz', 'conversations', filter, search],
    queryFn: () => api.waBizConversations(filter, search),
    // A customer writing while somebody reads is the point of the screen.
    refetchInterval: 15_000,
  });
  const { data: thread } = useQuery({
    queryKey: ['wa-biz', 'messages', activeId],
    queryFn: () => api.waBizMessages(activeId!),
    enabled: Boolean(activeId),
    refetchInterval: activeId ? 10_000 : false,
  });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
  const { data: templates } = useQuery({
    queryKey: ['wa-biz', 'templates', 'saved'],
    queryFn: () => api.waBizSavedTemplates(),
  });
  const [templateId, setTemplateId] = useState('');

  const active = (conversations ?? []).find((row) => row.id === activeId) ?? null;
  const messages = (thread?.messages ?? []) as unknown as BizMessage[];

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['wa-biz'] });
  };

  const send = useMutation({
    mutationFn: (input: { text?: string; attachmentId?: string }) => api.waBizSend({
      to: active!.handle,
      text: input.text,
      attachmentId: input.attachmentId,
      recordId: active!.recordId ?? undefined,
    }),
    onSuccess: () => { setDraft(''); refresh(); },
    onError: (err: Error) => toast.error('Could not send', err.message),
  });

  /*
    A file goes into the CRM first and is sent from there.

    Never straight to the provider: the CRM's own copy is what the
    conversation, the contact's Files tab and every future vendor read, and a
    file that only ever existed at a vendor is a broken square a year from now.
  */
  const attach = useMutation({
    mutationFn: async (file: File) => {
      const uploaded = await api.uploadFile(
        file,
        active?.recordId ?? undefined,
        active?.recordModule ?? undefined,
      );
      return send.mutateAsync({ text: draft.trim() || undefined, attachmentId: uploaded.id });
    },
    onError: (err: Error) => toast.error('Could not send that file', err.message),
  });

  /*
    The template as this customer would read it, before it goes.

    A positional template is unreadable in the abstract — "{{1}}, your {{2}} at
    {{3}}" says nothing about whether the mapping is right, and the customer is
    otherwise the one who finds out. Asked only when a template is picked and
    the thread has a record to fill it from.
  */
  const { data: preview } = useQuery({
    queryKey: ['wa-biz', 'preview', templateId, active?.recordId],
    queryFn: () => api.waBizTemplatePreview(templateId, active!.recordModule ?? 'leads', active!.recordId!),
    enabled: Boolean(templateId && active?.recordId),
  });

  const sendTemplate = useMutation({
    mutationFn: () => api.waBizSendTemplate({
      templateId,
      module: active!.recordModule ?? 'leads',
      recordId: active!.recordId!,
      to: active!.handle,
    }),
    onSuccess: () => { setTemplateId(''); refresh(); toast.success('Template sent'); },
    onError: (err: Error) => toast.error('Could not send that template', err.message),
  });

  // Opening a thread is what marks it read — receiving it is not.
  useEffect(() => {
    if (!activeId) return;
    void api.waBizRead(activeId).then(refresh).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, activeId]);

  if (status && !status.connected) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<MessageCircle className="h-8 w-8" />}
          title="WhatsApp Business is not connected yet"
          body="An admin adds a provider — Meta Cloud API, AiSensy, Gupshup or whatsmarketing.in — in Admin → Integrations, pastes its credentials and presses Test."
          action={<Link className="btn-primary btn-sm" to="/admin/integrations">Open Integrations</Link>}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* The queue */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 dark:border-slate-800">
        <div className="space-y-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, number or message"
              aria-label="Search chats"
              className="input h-8 w-full pl-8 text-xs"
            />
          </div>
          <Select
            value={filter}
            onChange={(value) => setFilter(value as Filter)}
            options={FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>}
          {!isLoading && !(conversations ?? []).length && (
            <p className="p-6 text-center text-xs text-muted">Nothing here yet.</p>
          )}
          {(conversations ?? []).map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => setActiveId(row.id)}
              className={cn(
                'flex w-full items-start gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition-colors dark:border-slate-800',
                row.id === activeId ? 'bg-brand-50 dark:bg-brand-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
              )}
            >
              <Avatar name={row.recordLabel ?? row.contactName ?? row.handle} size={32} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{row.recordLabel ?? row.contactName ?? row.handle}</span>
                  {row.unreadCount > 0 && (
                    <span className="rounded-full bg-emerald-600 px-1.5 text-2xs font-bold text-white">{row.unreadCount}</span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">{row.lastMessagePreview ?? '—'}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-slate-400">
                  {row.assignedName
                    ? <span className="inline-flex items-center gap-1"><CircleUser className="h-3 w-3" />{row.assignedName}</span>
                    : <span className="rounded bg-amber-100 px-1 font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">Unassigned</span>}
                  {row.status !== 'open' && <span className="rounded bg-slate-100 px-1 dark:bg-slate-800">{row.status}</span>}
                  {row.lastMessageAt && <span>{relativeTime(row.lastMessageAt)}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* The conversation */}
      <section className="flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-950/40">
        {!active ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<Inbox className="h-8 w-8" />} title="Pick a chat" body="Conversations on the business number appear on the left." />
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{active.recordLabel ?? active.contactName ?? active.handle}</p>
                <p className="text-2xs text-muted">+{active.handle} · {active.assignedName ?? 'Unassigned'}</p>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {/* Somebody else has this thread open. Shown rather than
                    guessed at, because two replies to one customer is the
                    thing a shared inbox is supposed to prevent. */}
                {(thread?.alsoViewing ?? []).length > 0 && (
                  <span className="rounded-md bg-amber-100 px-2 py-1 text-2xs font-semibold text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                    {(thread!.alsoViewing).join(', ')} also here
                  </span>
                )}
                {active.assignedTo !== me?.id && (
                  <button className="btn-secondary btn-sm" onClick={() => void api.waBizTake(active.id).then(refresh)}>
                    <UserPlus className="h-3.5 w-3.5" /> Take
                  </button>
                )}
                <Select
                  value={active.assignedTo ?? ''}
                  onChange={(value) => void api.waBizAssign(active.id, value || null).then(refresh)}
                  placeholder="Assign to…"
                  options={[{ value: '', label: 'Unassigned' }, ...(users ?? []).map((user) => ({
                    value: String(user.id), label: String(user.fullName ?? user.email),
                  }))]}
                />
                <Select
                  value={active.status}
                  onChange={(value) => void api.waBizStatusSet(active.id, value as 'open' | 'pending' | 'resolved').then(refresh)}
                  options={[
                    { value: 'open', label: 'Open' },
                    { value: 'pending', label: 'Pending' },
                    { value: 'resolved', label: 'Resolved' },
                  ]}
                />
                <button className="btn-ghost btn-sm" onClick={() => void api.waBizUnread(active.id).then(refresh)}>
                  Mark unread
                </button>
              </div>
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn('flex', message.direction === 'outbound' ? 'justify-end' : 'justify-start')}
                >
                  <div className={cn(
                    'max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm',
                    message.direction === 'outbound'
                      ? 'rounded-br-sm bg-emerald-600 text-white'
                      : 'rounded-bl-sm bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100',
                  )}>
                    {(() => {
                      const media = readMessageMedia(message.media);
                      return media ? (
                        <div className="mb-1 min-w-[12rem]">
                          <WhatsAppMedia media={media} dark={message.direction === 'outbound'} />
                        </div>
                      ) : null;
                    })()}
                    {message.body && message.body !== `[${message.type}]` && (
                      <p className="whitespace-pre-wrap break-words">{message.body}</p>
                    )}
                    <p className={cn(
                      'mt-1 flex items-center gap-1 text-2xs',
                      message.direction === 'outbound' ? 'text-emerald-100' : 'text-slate-400',
                    )}>
                      {new Date(message.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {message.direction === 'outbound' && (
                        <>
                          <span>·</span>
                          {message.status === 'failed'
                            ? <span title={message.error_message ?? ''}>failed</span>
                            : <span className="inline-flex items-center gap-0.5">
                              <CheckCheck className="h-3 w-3" />{message.status}
                            </span>}
                          {/* Which road it took, because the business number
                              and a rep's own phone are different phones. */}
                          {message.route === 'agent' && <span>· agent phone</span>}
                        </>
                      )}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>

            <footer className="border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              {!active.windowOpen && (
                <div className="mb-2 space-y-2 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
                  <p className="flex items-center gap-1.5 text-xs text-amber-900 dark:text-amber-200">
                    <Clock className="h-3.5 w-3.5" />
                    Outside WhatsApp&rsquo;s 24-hour window, so only an approved template can be sent.
                  </p>
                  {!active.recordId ? (
                    <p className="text-2xs text-amber-900/80 dark:text-amber-200/80">
                      A template is filled from the contact&rsquo;s own fields, so link this number to a
                      contact first.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={templateId}
                        onChange={setTemplateId}
                        placeholder="Choose an approved template…"
                        options={(templates ?? [])
                          .filter((template) => template.status.toUpperCase() === 'APPROVED')
                          .map((template) => ({ value: template.id, label: `${template.name} (${template.language})` }))}
                      />
                      <button
                        className="btn-primary btn-sm"
                        disabled={!templateId || sendTemplate.isPending || Boolean(preview?.missing.length)}
                        onClick={() => sendTemplate.mutate()}
                      >
                        {sendTemplate.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                        Send template
                      </button>
                    </div>
                  )}
                  {preview && (
                    <div className="rounded-md bg-white/70 p-2 text-xs dark:bg-slate-900/60">
                      <p className="whitespace-pre-wrap">{preview.preview}</p>
                      {preview.missing.length > 0 && (
                        // Named, not counted: this is fixable in ten seconds on
                        // the record, and "failed" would send somebody hunting.
                        <p className="mt-1 font-semibold text-rose-700 dark:text-rose-300">
                          {preview.missing.map((gap) => `{{${gap.slot}}} ${gap.reason}`).join('; ')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-end gap-2">
                <label
                  className={cn(
                    'btn-ghost btn-sm shrink-0 cursor-pointer',
                    (!active.windowOpen || attach.isPending) && 'pointer-events-none opacity-40',
                  )}
                  title="Send a photo or document"
                >
                  {attach.isPending ? <Spinner className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
                  <input
                    type="file"
                    className="hidden"
                    aria-label="Send a photo or document"
                    disabled={!active.windowOpen || attach.isPending}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      // Cleared straight away so picking the same file twice
                      // still fires a change, which is how a re-send after a
                      // failure otherwise does nothing at all.
                      event.target.value = '';
                      if (file) attach.mutate(file);
                    }}
                  />
                </label>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && draft.trim()) send.mutate({ text: draft.trim() });
                  }}
                  disabled={!active.windowOpen}
                  placeholder={active.windowOpen ? 'Type a reply… ⌘↵ to send' : 'Outside the 24-hour window'}
                  className="input min-h-[2.5rem] flex-1 resize-none"
                />
                <button
                  className="btn-primary btn-sm"
                  disabled={!draft.trim() || !active.windowOpen || send.isPending}
                  onClick={() => send.mutate({ text: draft.trim() })}
                >
                  {send.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} Send
                </button>
              </div>
            </footer>
          </>
        )}
      </section>

      {/* The CRM, linked rather than copied */}
      {active && (
        <aside className="hidden w-72 shrink-0 flex-col border-l border-slate-200 bg-white p-4 xl:flex dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-3 text-sm font-bold">Contact</h3>
          {active.recordId && active.recordModule ? (
            <>
              <Link
                to={`/${active.recordModule}/${active.recordId}`}
                className="block rounded-lg border border-slate-200 p-3 hover:border-brand-300 dark:border-slate-700"
              >
                <p className="truncate text-sm font-semibold">{active.recordLabel}</p>
                <p className="mt-0.5 text-2xs text-muted">Open the record</p>
              </Link>
              <p className="mt-3 text-2xs leading-4 text-muted">
                Status, requirement, budget, follow-ups and notes live on the record — one copy,
                so nothing here can disagree with it.
              </p>
            </>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">Nobody in the CRM holds this number.</p>
              <p className="mt-1">Create a contact or link an existing one from the Chats list — the CRM never
                makes a second contact on its own.</p>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
