import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  BellOff, CheckCheck, Clock, Inbox, MessageCircle, Paperclip, Search, Send,
} from 'lucide-react';
import { relativeTime, type RecordEnvelope } from '@ipropy/shared';
import { api, type ModuleSummary } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { useFillHeight } from '../lib/fillHeight';
import {
  bubbleTime, composerMode, dayLabel, displayNumber, moduleTag, outboundTone, wentOut, whyNoTextBox, windowLeft,
} from '../lib/whatsapp';
import { Avatar, EmptyState, Select, Skeleton, Spinner } from '../components/ui';
import { badgeVars } from '../lib/color';
import { ChatRecordPane, ChatRecordPaneSkeleton, useChatRecord } from '../components/ChatRecordPane';
import { HeaderFieldStrip } from '../components/RecordBlocks';
import { FieldValue } from '../components/FieldRenderer';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { readMessageMedia, WhatsAppMedia } from '../components/WhatsAppMedia';
import { UnsubscribedPanel, UnsubscribeLink } from '../components/WhatsAppConsent';

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

type Filter = 'all' | 'mine' | 'unassigned' | 'unread';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All chats' },
  { value: 'mine', label: 'My chats' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'unread', label: 'Unread' },
];

/*
  One dropdown, two kinds of answer: whose chat it is (or whether it is read),
  and which module the person on the other end is a record of. A module entry is prefixed so the two
  cannot collide, and the modules themselves come from the CRM's own metadata —
  there are two today and an admin may add a third with no deploy, so no module
  is ever named in this file.
*/
const MODULE_PREFIX = 'module:';

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
  const [filter, setFilter] = useState<Filter>('all');
  // Empty means every module. Set from the same dropdown, prefixed so a module
  // name can never be mistaken for a status.
  const [moduleFilter, setModuleFilter] = useState('');
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const [shell, shellHeight] = useFillHeight<HTMLDivElement>();
  const { data: status } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  const { data: conversations, isLoading } = useQuery({
    queryKey: ['wa-biz', 'conversations', filter, search, moduleFilter],
    queryFn: () => api.waBizConversations(filter, search, moduleFilter),
    // A customer writing while somebody reads is the point of the screen.
    refetchInterval: 15_000,
  });
  const { data: thread } = useQuery({
    queryKey: ['wa-biz', 'messages', activeId],
    queryFn: () => api.waBizMessages(activeId!),
    enabled: Boolean(activeId),
    refetchInterval: activeId ? 10_000 : false,
  });
  // For the "Contacts chats" entries in the dropdown and the sticker on each
  // row. Metadata, so a module an admin adds appears here with no deploy.
  const { data: modules } = useQuery({ queryKey: ['modules'], queryFn: () => api.modules() });
  const { data: templates } = useQuery({
    queryKey: ['wa-biz', 'templates', 'saved'],
    queryFn: () => api.waBizSavedTemplates(),
  });
  const [templateId, setTemplateId] = useState('');

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

  /*
    Arriving from a record's "Open in WhatsApp": open that person's chat.
    Done once and then taken off the address, so the list refreshing every
    fifteen seconds cannot keep dragging the screen back to it.
  */
  const [searchParams, setSearchParams] = useSearchParams();
  const wantedRecord = searchParams.get('record');
  useEffect(() => {
    if (!wantedRecord || !conversations) return;
    const row = conversations.find((candidate) => candidate.recordId === wantedRecord);
    if (row) { setActiveId(row.id); setPicked(row); }
    setSearchParams((params) => { params.delete('record'); return params; }, { replace: true });
  }, [wantedRecord, conversations, setSearchParams]);
  /** What to call them: the CRM's name for this person, else the number. */
  const who = active ? (active.recordLabel ?? active.contactName ?? active.handle) : '';
  /*
    The record behind this conversation, on the same query keys the record
    page and the split view use — so an edit made here refreshes there, and
    opening one warms the other.
  */
  const { module: recordModule, record: recordRow, failed: recordFailed } = useChatRecord(
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

  const consent = useMutation({
    mutationFn: (subscribed: boolean) => api.waBizConversationConsent(active!.id, subscribed),
    onSuccess: ({ optedOut, notedInWhatsMarketing }) => {
      toast.success(
        optedOut ? 'Unsubscribed from WhatsApp' : 'Subscribed to WhatsApp again',
        notedInWhatsMarketing ? 'A note saying so is on their contact in WhatsMarketing too.' : undefined,
      );
      refresh();
    },
    onError: (err: Error) => toast.error('Could not change that', err.message),
  });

  const send = useMutation({
    mutationFn: (input: { text?: string; attachmentId?: string }) => api.waBizSend({
      to: active!.handle,
      text: input.text,
      attachmentId: input.attachmentId,
      recordId: active!.recordId ?? undefined,
    }),
    onSuccess: () => { setDraft(''); refresh(); },
    onError: (err: Error) => {
      /*
        The message is already a row, marked failed with the provider's own
        reason on it — `sendOnBusinessNumber` writes that before it throws. So
        refresh: the rep sees their own words sitting in the thread with "NOT
        delivered" and the reason under them, which is what WhatsApp does and
        what the bubble is already built to draw. Without this the message
        simply vanished off the screen and only a toast remained.
      */
      refresh();
      toast.error('Could not send', err.message);
    },
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
      <aside className="flex w-80 shrink-0 flex-col border-r border-[var(--border)]">
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
            value={moduleFilter ? `${MODULE_PREFIX}${moduleFilter}` : filter}
            onChange={(value) => {
              if (value.startsWith(MODULE_PREFIX)) {
                setModuleFilter(value.slice(MODULE_PREFIX.length));
                setFilter('all');
                return;
              }
              setModuleFilter('');
              setFilter(value as Filter);
            }}
            options={[
              ...FILTERS.map((entry) => ({ value: entry.value, label: entry.label })),
              ...(modules ?? [])
                .filter((entry) => entry.isEntity && entry.showInMenu)
                .map((entry) => ({
                  value: `${MODULE_PREFIX}${entry.name}`,
                  label: `${entry.label} chats`,
                })),
            ]}
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
              modules={modules}
              onSelect={() => { setActiveId(row.id); setPicked(row); }}
            />
          ))}
        </div>
      </aside>

      {/* The conversation */}
      <section className="flex min-w-0 flex-1 flex-col bg-[var(--surface-muted)] dark:bg-slate-950/40">
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
            {/*
              **The record's own header, and nothing else.** 25 September 2026,
              the owner: *"I want this header in WhatsApp module to exactly
              match the header we have for the record."* So the chips saying
              "Template only" and "Open", the follow-up box, Send a property,
              Mark unread and the three dots are gone, and what is left is the
              split view's header drawn from the same fields: the name, who the
              record is assigned to, when it was last touched, and the strip an
              admin arranges in Admin → Split View.

              A thread nobody has linked to a record has no header fields to
              show, so it gets the name and the number and nothing pretending
              to be more.
            */}
            <header className="border-b border-[var(--border)] bg-white px-4 py-2.5 dark:bg-slate-900">
              <div className="flex min-w-0 items-start gap-3">
                <Avatar name={who} size={42} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  {recordModule && recordRow ? (
                    <ChatRecordHeader module={recordModule} record={recordRow} who={who} />
                  ) : (
                    <>
                      <h2 className="truncate text-xl font-extrabold tracking-tight text-slate-950 dark:text-white">{who}</h2>
                      <p className="mt-0.5 text-sm font-semibold text-slate-600 dark:text-slate-300">
                        {displayNumber(active.handle, active.waId)}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </header>

            {/*
              A tinted canvas, so a white incoming bubble reads as a bubble.
              On white it did not: the conversation looked like a page with
              faint boxes on it rather than like a chat, which is the whole of
              the familiarity the owner asked for.
            */}
            <div className="flex-1 space-y-2 overflow-y-auto bg-slate-100 p-4 dark:bg-slate-950">
              {messages.map((message, index) => (
                <div key={message.id}>
                  {/*
                    The date once, down the middle, the way WhatsApp does it —
                    instead of on all forty bubbles from one afternoon.
                  */}
                  {dayLabel(message.created_at) !== (index > 0 ? dayLabel(messages[index - 1]!.created_at) : null) && (
                    <div className="flex justify-center py-2">
                      <span className="rounded-md bg-white px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
                        {dayLabel(message.created_at)}
                      </span>
                    </div>
                  )}
                <div
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
                      {bubbleTime(message.created_at)}
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
                </div>
              ))}
              <div ref={endRef} />
            </div>

            <footer className="border-t border-[var(--border)] bg-white p-3 dark:bg-slate-900">
              {active.optedOut ? (
                <UnsubscribedPanel who={who} onSubscribeAgain={() => consent.mutateAsync(true)} />
              ) : (
              <>
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
              <div className="mt-1.5 flex justify-end">
                <UnsubscribeLink who={who} onUnsubscribe={() => consent.mutateAsync(false)} />
              </div>
              </>
              )}
            </footer>
          </>
        )}
      </section>

      {/*
        The contact itself, not a card about it.

        **20 September 2026, the owner:** *"I don't want to switch screen
        during whatsapp chat and then and there I want all info of that record
        everything in the right pane."* So this is the record's own field
        cards and notes box — the same components the split view renders, from
        the same metadata — every value editable where it stands.
      */}
      {active && (
        <aside className="hidden w-[24rem] shrink-0 flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--surface-muted)] p-3 xl:flex 2xl:w-[28rem] dark:bg-slate-950/40">
          {active.recordId && active.recordModule ? (
            recordModule && recordRow
              ? <ChatRecordPane module={recordModule} record={recordRow} />
              /*
                **A failed fetch is not a slow one.** These boxes used to wait
                for ever on a record that was never coming — the grey pane the
                owner reported on 25 September. It says so now, which is the
                difference between "still loading" and "go and look".
              */
              : recordFailed
                ? (
                  <div className="card p-3 text-xs text-muted">
                    <p className="font-semibold text-slate-700 dark:text-slate-200">This contact could not be opened.</p>
                    <p className="mt-1">It may have been deleted, moved to another module, or be outside what you can see.</p>
                  </div>
                )
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
function ChatQueueRow({ row, active, onSelect, modules }: {
  row: ChatRow; active: boolean; onSelect: () => void; modules: ModuleSummary[] | undefined;
}): JSX.Element {
  const who = row.recordLabel ?? row.contactName ?? row.handle;
  const replyWindow = windowLeft(row.windowExpiresAt);
  const tag = moduleTag(modules?.find((entry) => entry.name === row.recordModule));
  const tagColour = modules?.find((entry) => entry.name === row.recordModule)?.color;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex w-full items-stretch gap-2.5 border-b border-slate-100 py-2.5 pl-2 pr-3 text-left transition-colors dark:border-slate-800',
        active ? 'bg-brand-50 dark:bg-brand-950/50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70',
      )}
    >
      {active && <span className="absolute inset-y-0 left-0 w-1 bg-brand-600" aria-hidden />}

      {/*
        **The reply window, down the left of every chat.** 25 September 2026,
        the owner. Green with the hours left while a free reply may still go;
        yellow with "Exp" once only an approved template can reopen the
        conversation. Read from the same expiry the composer checks, so the bar
        and the box underneath it can never disagree.
      */}
      <span
        className="flex w-9 shrink-0 flex-col items-center gap-1"
        title={replyWindow.open ? `A free reply can go for ${replyWindow.label} more` : 'The 24-hour window has shut: send a template to start again'}
      >
        <span className={cn(
          'inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-bold tabular-nums',
          replyWindow.open
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200'
            : 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
        )}>
          {!replyWindow.open && <Clock className="h-2.5 w-2.5" />}
          {replyWindow.label}
        </span>
        <span className={cn('w-1 flex-1 rounded-full', replyWindow.open ? 'bg-emerald-500' : 'bg-amber-400')} aria-hidden />
      </span>

      <span className="relative shrink-0 self-start">
        <Avatar name={who} size={36} />
        {row.unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500 dark:border-slate-900" title="Waiting for a reply" />
        )}
      </span>
      <span className="min-w-0 flex-1 self-start">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">{who}</span>
          {row.optedOut && (
            <BellOff className="h-3 w-3 shrink-0 text-rose-600 dark:text-rose-400" aria-label="Unsubscribed from WhatsApp" />
          )}
        </span>
        <span className="mt-1 block truncate text-xs text-slate-500">{row.lastMessagePreview ?? 'No messages yet'}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 self-start pt-2">
        {row.lastMessageAt
          ? <span className="px-1.5 py-0.5 text-2xs font-bold text-slate-400">{relativeTime(row.lastMessageAt)}</span>
          : <span className="px-1.5 py-0.5 text-2xs font-bold text-slate-300">—</span>}
        {row.unreadCount > 0 ? (
          <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-2xs font-bold text-white">{row.unreadCount} new</span>
        ) : !row.assignedName ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-bold text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">Unassigned</span>
        ) : (
          <span className="max-w-[7rem] truncate px-1.5 py-0.5 text-2xs font-semibold text-slate-400">{row.assignedName}</span>
        )}
      </span>

      {/*
        **LD or INV, hanging from the top-right corner.** Which module the
        person is a record of, in the smallest space that still reads — above
        the time and out of the name's way, where the old sticker beside the
        name made long names truncate for it. The module's own colour, through
        `badgeVars`, so it clears contrast in both themes.
      */}
      {tag && (
        <span
          style={badgeVars(tagColour)}
          className="badge-tinted absolute right-2 top-0 rounded-b-md px-1.5 pb-px text-[9px] font-extrabold leading-tight tracking-wide"
          title={`A record in ${modules?.find((entry) => entry.name === row.recordModule)?.label ?? ''}`}
        >
          {tag}
        </span>
      )}
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
function ChatRecordHeader({ module, record, who }: {
  module: DescribedModule; record: RecordEnvelope; who: string;
}): JSX.Element {
  const { headerFields, assignedField } = useRecordPanes(module);
  return (
    <>
      <div className="flex min-w-0 items-center gap-x-3 whitespace-nowrap">
        <h2 className="min-w-[9rem] truncate text-xl font-extrabold tracking-tight text-slate-950 dark:text-white">{who}</h2>
        {/*
          **One assignment, the record's.** A contact assigned to Vijay is
          Vijay's in WhatsApp too, and it changes where the record changes —
          read here straight off the record's own field, so there is no second
          copy on the conversation to drift out of step with it.
        */}
        {assignedField && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-sm">
            <span className="text-xs font-normal text-muted">Assigned To:</span>
            <FieldValue
              field={assignedField}
              value={record.values[assignedField.name]}
              display={record.display?.[assignedField.name]}
              compact
            />
          </span>
        )}
        <span className="min-w-0 truncate text-sm text-slate-400">Updated {relativeTime(record.updatedAt)}</span>
      </div>
      <HeaderFieldStrip
        module={module}
        row={record}
        fields={headerFields}
        canEdit={record.can?.edit ?? module.permissions.edit}
        className="mt-2"
      />
    </>
  );
}
