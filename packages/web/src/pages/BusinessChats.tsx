import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Building2, CalendarClock, Check, CheckCheck, Clock, Inbox, MailOpen, MessageCircle,
  MoreHorizontal, Paperclip, Search, Send, UserPlus,
} from 'lucide-react';
import { relativeTime, type RecordEnvelope } from '@ipropy/shared';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { useFillHeight } from '../lib/fillHeight';
import { composerMode, displayNumber, outboundTone, wentOut, whyNoTextBox } from '../lib/whatsapp';
import { Avatar, Dropdown, DropdownItem, EmptyState, Select, Skeleton, Spinner } from '../components/ui';
import { ACTION_CIRCLE } from '../lib/actionCircle';
import { ChatRecordPane, ChatRecordPaneSkeleton, useChatRecord } from '../components/ChatRecordPane';
import { HeaderFieldStrip } from '../components/RecordBlocks';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { readMessageMedia, WhatsAppMedia } from '../components/WhatsAppMedia';
import { SharePropertyDialog } from '../components/SharePropertyDialog';

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

/** One row of the queue, as `listConversations` returns it. */
type ChatRow = Awaited<ReturnType<typeof api.waBizConversations>>[number];

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

  const [shell, shellHeight] = useFillHeight<HTMLDivElement>();
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
  const [sharing, setSharing] = useState(false);
  const [followUpOn, setFollowUpOn] = useState('');

  /*
    **The open conversation must survive the list changing under it.**

    It used to be looked up in the filtered list alone, so typing in the
    search box, switching the filter, or simply the fifteen-second refresh
    dropping it off the page emptied the middle column back to "Pick a chat" —
    mid-sentence, with a customer waiting. A person who has opened a thread
    has made a decision; a list re-query has not un-made it.

    So the row is kept when it is picked, and the live one is preferred when
    it is still there — the kept copy is a fallback, never the source of
    truth, or an assignment made elsewhere would never show.
  */
  const [picked, setPicked] = useState<ChatRow | null>(null);
  const active = (conversations ?? []).find((row) => row.id === activeId) ?? picked;
  /** What to call them: the CRM's name for this person, else the number. */
  const who = active ? (active.recordLabel ?? active.contactName ?? active.handle) : '';
  /*
    The record behind this conversation, on the same query keys the record
    page and the split view use — so an edit made here refreshes there, and
    opening one warms the other.
  */
  const { module: recordModule, record: recordRow } = useChatRecord(
    active?.recordModule ?? null,
    active?.recordId ?? null,
  );
  const messages = (thread?.messages ?? []) as unknown as BizMessage[];
  /*
    **Both halves, not just the clock.** A free reply needs an open 24-hour
    window *and* a provider that can carry one — AiSensy's API sends approved
    templates and nothing else, window or no window. The record's composer has
    always asked `composerMode`; this screen only looked at the window, so on
    such a provider it would offer a box whose every send was refused.
  */
  const mode = composerMode(status?.capabilities ?? [], Boolean(active?.windowOpen));

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
    A date typed in the chat goes straight to the one definition of a
    follow-up — the date on the record, a note in the timeline, a nudge to
    whoever owns the lead. Nothing about "chase them" is decided here.
  */
  const followUp = useMutation({
    mutationFn: (on: string) => api.waBizFollowUp(active!.id, on),
    onSuccess: (result) => {
      setFollowUpOn('');
      toast.success('Follow-up set', `You will be reminded on ${result.on}.`);
      refresh();
    },
    onError: (err: Error) => toast.error('Could not set that follow-up', err.message),
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
    /*
      Measured, not guessed. `calc(100vh - 3.5rem)` assumed this screen sat
      directly under the app header; from 20 September it also sits under the
      WhatsApp page's tab strip, and the composer went off the bottom edge.
      See `useFillHeight` — the second time this exact guess has cost a bug.
    */
    <div ref={shell} style={{ height: shellHeight ?? undefined }} className="flex overflow-hidden">
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
            <ChatQueueRow
              key={row.id}
              row={row}
              active={row.id === activeId}
              onSelect={() => { setActiveId(row.id); setPicked(row); }}
            />
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
            {/*
              The record header from the split view, wearing the same clothes.

              One line for who this is — avatar, name, who holds it, when they
              last wrote — and one strip of facts under it that never wraps.
              The controls are the same grey circles: at rest one weight of
              grey, filling with their own colour under the cursor, because
              four tinted circles in a row read as four warnings. It used to be
              five bordered buttons and two dropdowns wrapping onto a second
              row, which is what the owner was looking at when he asked for
              this page to look like that one.
            */}
            <header className="border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex min-w-0 items-start gap-3">
                <Avatar name={who} size={42} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-x-3 whitespace-nowrap">
                    <h2 className="min-w-0 truncate text-xl font-extrabold tracking-tight text-slate-950 dark:text-white">{who}</h2>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-sm">
                      <span className="text-xs font-normal text-muted">Assigned To:</span>
                      <Select
                        value={active.assignedTo ?? ''}
                        onChange={(value) => void api.waBizAssign(active.id, value || null).then(refresh)}
                        placeholder="Unassigned"
                        options={[{ value: '', label: 'Unassigned' }, ...(users ?? []).map((user) => ({
                          value: String(user.id), label: String(user.fullName ?? user.email),
                        }))]}
                      />
                    </span>
                    {active.lastMessageAt && (
                      <span className="shrink-0 text-sm text-slate-400">Last message {relativeTime(active.lastMessageAt)}</span>
                    )}
                  </div>

                  {/*
                    The facts, on one line under the name — the number, whether
                    a free reply can go at all, and where the thread stands.
                    Facts, not controls: the controls are the circles beside
                    them.
                  */}
                  {/*
                    The record's own facts, the same strip the split view's
                    header carries — Contact Type, Mobile, Unit Number,
                    Budget, Next Follow-up, Lead Status, whatever the admin
                    arranged. The owner asked for exactly this on 20 September:
                    *"I need those things in header which are there in
                    screenshot 2"*. Editable where they stand, so a budget can
                    be corrected mid-conversation without leaving it.
                  */}
                  {recordModule && recordRow && (
                    <ChatHeaderFields module={recordModule} record={recordRow} />
                  )}

                  <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs">
                    <span className="shrink-0 font-semibold text-slate-600 dark:text-slate-300">{displayNumber(active.handle, active.waId)}</span>
                    <span className="text-slate-300">·</span>
                    {mode === 'text'
                      ? <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-2xs font-bold text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">Can reply freely</span>
                      : <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-bold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">Template only</span>}
                    <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-2xs font-bold capitalize text-slate-700 dark:bg-slate-700 dark:text-slate-200">{active.status}</span>
                    {/* Somebody else has this thread open. Shown rather than
                        guessed at, because two replies to one customer is the
                        thing a shared inbox is supposed to prevent. */}
                    {(thread?.alsoViewing ?? []).length > 0 && (
                      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-bold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                        {(thread!.alsoViewing).join(', ')} also here
                      </span>
                    )}
                    <label className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-2xs dark:border-slate-700" title="Chase them on a day">
                      <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
                      <span className="text-muted">Follow up</span>
                      {/*
                        A date, not a dialog. Deciding to chase somebody on
                        Tuesday takes one tap, and anything longer gets skipped
                        in the middle of a conversation — which is how
                        follow-ups stop happening.
                      */}
                      <input
                        type="date"
                        aria-label="Follow up on"
                        className="bg-transparent text-2xs outline-none"
                        min={new Date().toISOString().slice(0, 10)}
                        value={followUpOn}
                        disabled={followUp.isPending}
                        onChange={(event) => {
                          setFollowUpOn(event.target.value);
                          if (event.target.value) followUp.mutate(event.target.value);
                        }}
                      />
                    </label>
                  </div>
                </div>

                <span className="mt-1 flex shrink-0 items-center gap-2">
                  {active.assignedTo !== me?.id && (
                    <button
                      className={cn(ACTION_CIRCLE, 'hover:bg-emerald-600')}
                      aria-label="Take this chat"
                      title="Take this chat"
                      onClick={() => void api.waBizTake(active.id).then(refresh)}
                    >
                      <UserPlus className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    className={cn(ACTION_CIRCLE, 'hover:bg-brand-600')}
                    aria-label="Send a property"
                    title="Send a property to this buyer"
                    onClick={() => setSharing(true)}
                  >
                    <Building2 className="h-4 w-4" />
                  </button>
                  <button
                    className={cn(ACTION_CIRCLE, 'hover:bg-slate-600')}
                    aria-label="Mark unread"
                    title="Mark unread"
                    onClick={() => void api.waBizUnread(active.id).then(refresh)}
                  >
                    <MailOpen className="h-4 w-4" />
                  </button>
                  {/*
                    Open / Pending / Resolved in the menu the record page has,
                    rather than a dropdown of its own taking a third of the
                    header. The one it is on is ticked, so the menu also says
                    where the thread stands.
                  */}
                  <Dropdown
                    align="right"
                    className="min-w-[12rem]"
                    trigger={(
                      <button className={cn(ACTION_CIRCLE, 'hover:bg-slate-600')} aria-label="More actions" title="More actions">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        {(['open', 'pending', 'resolved'] as const).map((value) => (
                          <DropdownItem
                            key={value}
                            icon={active.status === value ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                            onClick={() => {
                              close();
                              void api.waBizStatusSet(active.id, value).then(refresh);
                            }}
                          >
                            <span className="capitalize">{value}</span>
                          </DropdownItem>
                        ))}
                      </>
                    )}
                  </Dropdown>
                </span>
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
                    // A refused message must not wear the same green as a
                    // delivered one. Same rule as the record's tab; this is
                    // the second screen it had to be applied to.
                    message.direction === 'outbound'
                      ? `rounded-br-sm text-white ${outboundTone(message.status)}`
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
                    {/*
                      A photo the CRM never managed to collect used to render
                      as an empty bubble — invisible white on white, which
                      reads as a gap in the conversation rather than as a
                      message. `readMessageMedia` refuses the vendor's own
                      link on purpose (it expires), so the honest answer is to
                      name the thing and say it is not here.
                    */}
                    {!readMessageMedia(message.media)
                      && (!message.body || message.body === `[${message.type}]`) && (
                      <p className="italic opacity-70">
                        {message.type === 'text' ? 'Empty message' : `${message.type} — not saved in the CRM`}
                      </p>
                    )}
                    <p className={cn(
                      'mt-1 flex items-center gap-1 text-2xs',
                      message.direction === 'outbound' ? 'text-white/80' : 'text-slate-400',
                    )}>
                      {new Date(message.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {message.direction === 'outbound' && (
                        <>
                          <span>·</span>
                          {message.status === 'failed'
                            ? <span className="font-semibold">NOT delivered</span>
                            : <span className="inline-flex items-center gap-0.5">
                              <CheckCheck className="h-3 w-3" />{wentOut(message.status)}
                            </span>}
                          {/* Which road it took, because the business number
                              and a rep's own phone are different phones. */}
                          {message.route === 'agent' && <span>· agent phone</span>}
                        </>
                      )}
                    </p>
                    {/*
                      The reason, on the bubble rather than in a `title`
                      attribute. A tooltip is invisible on a touchscreen and
                      unfindable on a desktop, and "outside the 24-hour window"
                      is the difference between a rep fixing it in ten seconds
                      and a rep hunting.
                    */}
                    {message.direction === 'outbound' && message.status === 'failed' && (
                      <p className="mt-1 rounded bg-white/15 px-1.5 py-1 text-2xs leading-snug">
                        {message.error_message ?? 'WhatsApp gave no reason.'}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>

            <footer className="border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              {mode === 'template' && (
                <div className="mb-2 space-y-2 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
                  <p className="flex items-center gap-1.5 text-xs text-amber-900 dark:text-amber-200">
                    <Clock className="h-3.5 w-3.5" />
                    {whyNoTextBox(status?.capabilities ?? [], status?.provider ?? null)}
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
                    (mode === 'template' || attach.isPending) && 'pointer-events-none opacity-40',
                  )}
                  title="Send a photo or document"
                >
                  {attach.isPending ? <Spinner className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
                  <input
                    type="file"
                    className="hidden"
                    aria-label="Send a photo or document"
                    disabled={mode === 'template' || attach.isPending}
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
                  disabled={mode === 'template'}
                  placeholder={mode === 'text' ? 'Type a reply… ⌘↵ to send' : 'Only an approved template can go now'}
                  className="input min-h-[2.5rem] flex-1 resize-none"
                />
                <button
                  className="btn-primary btn-sm"
                  disabled={!draft.trim() || mode === 'template' || send.isPending}
                  onClick={() => send.mutate({ text: draft.trim() })}
                >
                  {send.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} Send
                </button>
              </div>
            </footer>
          </>
        )}
      </section>

      {sharing && active && (
        <SharePropertyDialog
          to={active.handle}
          contactId={active.recordId}
          contactLabel={active.recordLabel ?? active.contactName ?? active.handle}
          onClose={() => setSharing(false)}
          onSent={refresh}
        />
      )}

      {/*
        The contact itself, not a card about it.

        **20 September 2026, the owner:** *"I don't want to switch screen
        during whatsapp chat and then and there I want all info of that record
        everything in the right pane."* So this is the record's own field
        cards and notes box — the same components the split view renders, from
        the same metadata — every value editable where it stands.
      */}
      {active && (
        <aside className="hidden w-[24rem] shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-slate-50 p-3 xl:flex 2xl:w-[28rem] dark:border-slate-800 dark:bg-slate-950/40">
          {active.recordId && active.recordModule ? (
            recordModule && recordRow
              ? <ChatRecordPane module={recordModule} record={recordRow} />
              : <ChatRecordPaneSkeleton />
          ) : (
            <div className="card border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">Nobody in the CRM holds this number.</p>
              <p className="mt-1">
                Create a contact or link an existing one — the CRM never makes a second
                contact on its own.
              </p>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

/**
 * One chat in the queue, shaped like the split view's own queue row.
 *
 * The owner asked for this screen to feel like that page, so it is the same
 * row and not an approximation of it: the bar marking the open one is an
 * element rather than a border (two `border-l` utilities on one row let
 * Tailwind's stylesheet order decide the colour, and the marker came out slate
 * on slate once), the name is bold, the second line is the thing the row is
 * about, and the right-hand column carries the time above a single chip — two
 * lines each side. Two chips on two lines with two different right edges is
 * what makes a queue look ragged.
 *
 * Which chip, in order, is what the reader has to act on: how many are waiting,
 * then nobody has picked this up, then a thread somebody has parked, then who
 * holds it.
 */
function ChatQueueRow({ row, active, onSelect }: {
  row: ChatRow; active: boolean; onSelect: () => void;
}): JSX.Element {
  const who = row.recordLabel ?? row.contactName ?? row.handle;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex w-full items-start gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition-colors dark:border-slate-800',
        active ? 'bg-brand-50 dark:bg-brand-950/50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70',
      )}
    >
      {active && <span className="absolute inset-y-0 left-0 w-1 bg-brand-600" aria-hidden />}
      <span className="relative shrink-0">
        <Avatar name={who} size={36} />
        {row.unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500 dark:border-slate-900" title="Waiting for a reply" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-slate-900 dark:text-slate-100">{who}</span>
        <span className="mt-1 block truncate text-xs text-slate-500">{row.lastMessagePreview ?? 'No messages yet'}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {row.lastMessageAt
          ? <span className="px-1.5 py-0.5 text-2xs font-bold text-slate-400">{relativeTime(row.lastMessageAt)}</span>
          : <span className="px-1.5 py-0.5 text-2xs font-bold text-slate-300">—</span>}
        {row.unreadCount > 0 ? (
          <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-2xs font-bold text-white">{row.unreadCount} new</span>
        ) : !row.assignedName ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-bold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">Unassigned</span>
        ) : row.status !== 'open' ? (
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-2xs font-bold capitalize text-slate-700 dark:bg-slate-700 dark:text-slate-200">{row.status}</span>
        ) : (
          <span className="max-w-[7rem] truncate px-1.5 py-0.5 text-2xs font-semibold text-slate-400">{row.assignedName}</span>
        )}
      </span>
    </button>
  );
}

/**
 * The record's fact strip in the chat header.
 *
 * A component of its own only because `useRecordPanes` is a hook and the
 * header is rendered inside a conditional — calling it there would break the
 * rules of hooks. It renders the identical strip the split view's header does.
 */
function ChatHeaderFields({ module, record }: {
  module: DescribedModule; record: RecordEnvelope;
}): JSX.Element | null {
  const { headerFields } = useRecordPanes(module);
  if (!headerFields.length) return null;
  return (
    <HeaderFieldStrip
      module={module}
      row={record}
      fields={headerFields}
      canEdit={record.can?.edit ?? module.permissions.edit}
      className="mt-1"
    />
  );
}
