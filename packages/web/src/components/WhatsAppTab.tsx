import { useLiveCards } from '../lib/liveCards';
import { enterSends } from '../lib/enterToSend';
import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCheck, Clock, ExternalLink, MessageCircle, Paperclip, Send } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { readMessageMedia, readRemoteFile, WhatsAppMedia, WhatsAppRemoteFile } from './WhatsAppMedia';
import { UnsubscribedPanel, UnsubscribeLink } from './WhatsAppConsent';
import { BubbleKindFilter, countKinds } from './BubbleKindFilter';
import { BUBBLE_STYLE, type BubbleKind, bubbleKind, bubbleTime, composerMode, dayLabel, linkBanner, senderLine, ticks, whyNoTextBox } from '../lib/whatsapp';
import { EmptyState, Skeleton, Spinner } from './ui';
import SendFromPicker from './SendFromPicker';

/**
 * This contact's WhatsApp history, on the contact.
 *
 * Whoever sent it. The thread is not scoped to one reader — a manager who can
 * open the lead reads the whole conversation, and somebody who cannot open the
 * lead never gets here. Authority comes from the contact, not from the phone.
 *
 * Everything leaves from the official business number. The per-agent QR-linked
 * road was removed on 19 September 2026; rows it wrote are still here and still
 * read, and each one still says which phone it went through.
 */
export function WhatsAppTab({ module, recordId, mobile }: {
  module: string;
  recordId: string;
  mobile: string | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  /** The text of a message on its way: shown at once as a bubble that says Sending, so pressing Send feels instant. */
  const [pending, setPending] = useState<string | null>(null);
  /** Which bubble kinds are pressed in the colour key; empty means show everything. Resets per record. */
  const [kindFilter, setKindFilter] = useState<Set<BubbleKind>>(new Set());
  useEffect(() => setKindFilter(new Set()), [recordId]);

  /*
    A contact messaged on the business number last week and from a rep's own
    phone back in August has *one* conversation, and it reads as one column
    with a line saying which number each message went through.
  */
  const { data: business } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  const onBusiness = Boolean(business?.connected);

  const { data: contact, isLoading } = useQuery({
    queryKey: ['whatsapp', 'contact', module, recordId],
    enabled: onBusiness,
    /*
      **It has to refresh itself.** 20 September: the owner replied from his
      own phone, the CRM stored it within a minute — and the tab he was
      staring at never changed, because it fetched once when it opened and
      then sat there. From where he sat that is indistinguishable from the
      message never arriving, and it is what "it didn't show it here ASAP and
      not till now" actually was.

      Fifteen seconds, and again whenever the window is focused: a rep
      switching back from WhatsApp on their phone should find the CRM already
      caught up. It is a handful of small reads on a tab somebody has
      deliberately opened, not a background poll across the app.
    */
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const answer = await api.waBizContactMessages(module, recordId);
      return { optedOut: answer.optedOut, messages: answer.messages.map((row) => ({
        id: String(row.id),
        direction: row.direction as 'inbound' | 'outbound',
        body: (row.body as string | null) ?? null,
        media: row.media,
        createdAt: String(row.created_at),
        // Official API (workflow) or the company phone. Admins get `via`; everyone else only learns that a message was automatic.
        viaApi: Boolean(row.automated) || row.via === 'api',
        templateName: (row.template_name as string | null) ?? null,
        status: String(row.status ?? ''),
        error: (row.error_message as string | null) ?? null,
        numberName: (row.numberName as string | null) ?? null,
        numberPhone: (row.numberPhone as string | null) ?? null,
        sentByName: (row.sent_by_name as string | null) ?? null,
      })) };
    },
  });
  const messages = contact?.messages;
  const optedOut = Boolean(contact?.optedOut);

  const consent = useMutation({
    mutationFn: (subscribed: boolean) => api.waBizContactConsent(module, recordId, subscribed),
    onSuccess: ({ optedOut: nowOut, notedInWhatsMarketing }) => {
      toast.success(
        nowOut ? 'Unsubscribed from WhatsApp' : 'Subscribed to WhatsApp again',
        notedInWhatsMarketing ? 'A note saying so is on their contact in WhatsMarketing too.' : undefined,
      );
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'contact', module, recordId] });
      void queryClient.invalidateQueries({ queryKey: ['wa-biz'] });
    },
    onError: (err: Error) => toast.error('Could not change that', err.message),
  });

  // Tell the corner cards this chat is on screen, so they do not pop up over it.
  useEffect(() => {
    useLiveCards.getState().setOpenChat(recordId);
    return () => { if (useLiveCards.getState().openChatRecordId === recordId) useLiveCards.getState().setOpenChat(null); };
  }, [recordId]);
  const contactKey = ['whatsapp', 'contact', module, recordId];
  const send = useMutation({
    mutationFn: (text: string) => api.waBizSend({ to: mobile!, text, recordId }).then(() => undefined),
    onMutate: (text: string) => {
      setPending(text);
      setDraft('');
    },
    onSuccess: async () => {
      // The real row replaces the Sending bubble in the same breath, so nothing blinks out and back.
      await queryClient.invalidateQueries({ queryKey: contactKey });
      setPending(null);
    },
    onError: async (err: Error, text: string) => {
      setPending(null);
      // A refused send is a row too ("NOT delivered", with the reason). If the server wrote none (it refused before
      // writing, e.g. a daily limit), the text goes back into the box instead of being lost.
      await queryClient.refetchQueries({ queryKey: contactKey });
      const rows = (queryClient.getQueryData(contactKey) as { messages: Array<{ direction: string; status: string; body: string | null; createdAt: string }> } | undefined)?.messages ?? [];
      const shown = rows.some((m) => m.direction === 'outbound' && m.status === 'failed' && m.body === text && Date.now() - Date.parse(m.createdAt) < 60_000);
      if (!shown) setDraft(text);
      toast.error('Could not send', err.message);
    },
  });

  /*
    One attachment at a time, from this computer. It goes into the CRM first
    (the record's own Files) and is sent from there, never straight to the
    gateway — the same rule as the Chats screen.
  */
  const attach = useMutation({
    mutationFn: async (file: File) => {
      const uploaded = await api.uploadFile(file, recordId, module);
      await api.waBizSend({ to: mobile!, attachmentId: uploaded.id, text: draft.trim() || undefined, recordId });
    },
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'contact', module, recordId] });
    },
    onError: (err: Error) => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'contact', module, recordId] });
      toast.error('Could not send that file', err.message);
    },
  });

  /*
    **The window, not only the connection.** This box asked one question — is a
    provider switched on — and then let anybody type. On 20 September the owner
    sent six messages from it and WhatsApp refused every one: the 24-hour
    window had shut, and nothing on the screen said so until the failures came
    back. The composer beside the phone number has always asked `composerMode`;
    this tab is the same question and had a different answer.

    `text` needs both halves — an open window *and* a provider that can carry a
    free reply. Outside that, the honest thing is a shut box saying why, with
    the templates on the Chats screen as the way through.
  */
  const { data: thread } = useQuery({
    queryKey: ['wa-biz', 'thread', mobile, module, recordId],
    queryFn: () => api.waBizThread(mobile!, module, recordId),
    enabled: onBusiness && Boolean(mobile),
    refetchInterval: 30_000,
  });
  const mode = composerMode(business?.capabilities ?? [], Boolean(thread?.windowOpen));
  // OpenWA unreachable or the phone unlinked: the box is shut with the reason, not left to fail after a paragraph is typed.
  const linkProblem = linkBanner(business?.link);
  const linked = onBusiness && mode === 'text' && !linkProblem;

  /*
    Open at the newest message, the way WhatsApp does. The list scrolls on its
    own now, so without this it opened at the oldest one — and it follows new
    messages down as they arrive, so the fifteen-second refresh never leaves a
    reply sitting out of sight below the fold.
  */
  const bottomOf = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = bottomOf.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages?.length]);

  /*
    Opening the chat is reading it: the newest customer message marks the conversation read, so the unread badge in
    the inbox does not outlive somebody looking at the message. Quiet on failure — a rep who may read the thread on
    this record but not the inbox simply keeps their own unread count.
  */
  const lastInboundId = [...(messages ?? [])].reverse().find((m) => m.direction === 'inbound')?.id;
  const conversationId = thread?.conversationId ?? null;
  useEffect(() => {
    if (!conversationId || !lastInboundId || document.visibilityState !== 'visible') return;
    void api.waBizRead(conversationId)
      .then(() => queryClient.invalidateQueries({ queryKey: ['wa-biz'] }))
      .catch(() => undefined);
  }, [conversationId, lastInboundId, queryClient]);

  if (isLoading) return <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;

  const conversation = [
    ...(messages ?? []),
    ...(pending !== null ? [{
      id: 'pending', direction: 'outbound' as const, body: pending, media: null, createdAt: new Date().toISOString(),
      viaApi: false, templateName: null, status: 'sending', error: null, numberName: null, numberPhone: null, sentByName: null,
    }] : []),
  ];

  const visible = kindFilter.size === 0 ? conversation : conversation.filter((m) => kindFilter.has(bubbleKind(m)));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--border)] bg-white px-4 py-2 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-semibold">WhatsApp{mobile ? <span className="ml-2 font-normal text-muted">{mobile}</span> : null}</p>
          <Link
            to={`/whatsapp/chats?record=${recordId}`}
            className="inline-flex shrink-0 items-center gap-1.5 text-2xs font-semibold text-muted transition-colors hover:text-brand-600"
          >
            <ExternalLink className="h-3 w-3" />
            Open in WhatsApp
          </Link>
        </div>
        <BubbleKindFilter active={kindFilter} counts={countKinds(conversation, bubbleKind)} onChange={setKindFilter} />
      </div>
      {linkProblem && (
        <div role="alert" className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{linkProblem}</span>
        </div>
      )}
      <div ref={bottomOf} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-slate-100 p-3 dark:bg-slate-950">
        {conversation.length === 0 && (
          <EmptyState
            icon={<MessageCircle className="h-8 w-8" />}
            title="No WhatsApp yet"
            body={onBusiness
              ? 'No messages on either WhatsApp channel. Send the first one below.'
              : 'Ask an admin to connect the WhatsApp Business number in Admin → Integrations.'}
          />
        )}
        {conversation.length > 0 && visible.length === 0 && (
          <p className="py-8 text-center text-sm text-muted" role="status">No messages match. <button type="button" className="font-semibold underline" onClick={() => setKindFilter(new Set())}>Clear filter</button></p>
        )}
        {visible.map((m, index) => {
          const kind = bubbleKind(m);
          const style = BUBBLE_STYLE[kind];
          const out = m.direction === 'outbound';
          const failed = out && m.status === 'failed';
          const media = readMessageMedia(m.media);
          const remote = readRemoteFile(m.media);
          return (
            <div key={m.id}>
              {dayLabel(m.createdAt) !== (index > 0 ? dayLabel(visible[index - 1]!.createdAt) : null) && (
                <div className="flex justify-center py-2">
                  <span className="rounded-md bg-white px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
                    {dayLabel(m.createdAt)}
                  </span>
                </div>
              )}
              <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
                <div
                  data-kind={kind}
                  className={cn(
                    'max-w-[85%] rounded-xl border px-2.5 py-1.5 text-sm sm:max-w-[75%]',
                    style.bubble,
                    failed && 'border-rose-500 ring-1 ring-rose-500',
                  )}
                >
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">
                    {style.label}{m.templateName ? ` · template: ${m.templateName}` : ''}
                  </p>
                  {senderLine(m) && <p className="mb-0.5 text-[10px] opacity-80" data-testid="sender-line">{senderLine(m)}</p>}
                  {media && <div className="mb-1 min-w-[12rem]"><WhatsAppMedia media={media} /></div>}
                  {!media && remote && <div className="mb-1 min-w-[12rem]"><WhatsAppRemoteFile messageId={m.id} file={remote} /></div>}
                  {(m.body || !(media || remote)) && (
                    <p className="whitespace-pre-wrap break-words">
                      {m.body ?? <span className="italic opacity-70">Attachment</span>}
                    </p>
                  )}
                  <p className="mt-0.5 flex items-center justify-end gap-1 text-[10px] opacity-80">
                    {bubbleTime(m.createdAt)}
                    {m.status === 'sending' && <span className="flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden /> Sending…</span>}
                    {out && !failed && ticks(m.status).marks && (
                      ticks(m.status).marks === '✓'
                        ? <Check className="h-3 w-3" aria-label="sent" />
                        : <CheckCheck className={cn('h-3 w-3', ticks(m.status).read && 'text-sky-600 dark:text-sky-300')} aria-label={ticks(m.status).read ? 'read' : 'delivered'} />
                    )}
                    {out && m.status && m.status !== 'sending' && !failed && <span>{m.status === 'queued' ? 'sending' : m.status}</span>}
                  </p>
                  {failed && (
                    <p className="mt-1 rounded bg-rose-100 px-1.5 py-1 text-[11px] leading-snug text-rose-900 dark:bg-rose-950 dark:text-rose-100">
                      <strong>Failed.</strong> {m.error ?? 'WhatsApp gave no reason.'}
                    </p>
                  )}
                  {failed && m.body && !media && !remote && !m.viaApi && (
                    <button
                      type="button"
                      className="mt-1 rounded bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                      disabled={send.isPending || !linked}
                      onClick={() => send.mutate(m.body!)}
                    >
                      Retry
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/*
        The window has shut, so nothing free may go — but an approved template
        still can, and this is where a rep already is. Without it the only way
        to reach the customer from a record was to leave the record.
      */}
      {optedOut && (
        <div className="border-t border-[var(--border)] bg-white p-3 dark:bg-slate-900">
          <UnsubscribedPanel who="This person" onSubscribeAgain={() => consent.mutateAsync(true)} />
        </div>
      )}

      {!optedOut && onBusiness && mobile && (
        <p className="border-t border-[var(--border)] bg-white px-3 pt-2 text-2xs text-muted dark:bg-slate-900" data-testid="send-channel">
          Sending on <strong>WhatsApp chat (company phone)</strong>. API messages go out automatically from workflows.
        </p>
      )}
      {!optedOut && onBusiness && mobile && <SendFromPicker recordId={recordId} />}
      {!optedOut && (
      <form
        className="flex flex-wrap items-end gap-2 border-t border-[var(--border)] bg-white p-3 dark:bg-slate-900"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) send.mutate(draft.trim()); }}
      >
        <label
          className={cn(
            'btn-ghost btn-sm shrink-0 cursor-pointer',
            (!linked || !mobile || attach.isPending) && 'pointer-events-none opacity-40',
          )}
          title="Send one photo or document"
        >
          {attach.isPending ? <Spinner className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
          <input
            type="file"
            className="hidden"
            aria-label="Send one photo or document"
            disabled={!linked || !mobile || attach.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) attach.mutate(file);
            }}
          />
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (!enterSends(e.nativeEvent)) return;
            e.preventDefault();
            if (draft.trim() && !send.isPending && linked && mobile) send.mutate(draft.trim());
          }}
          rows={1}
          disabled={!linked || !mobile}
          placeholder={
            !mobile ? 'This contact has no mobile number'
              : !onBusiness ? 'No WhatsApp Business number is connected yet'
                : linkProblem ? 'WhatsApp is not connected right now, so nothing can be sent. Notes go in the Comments tab.'
                : linked ? 'Write a message — Enter sends, Shift+Enter for a new line'
                  // The reason, where the person is about to type — not after
                  // they have written a paragraph and pressed Send.
                  : whyNoTextBox(business?.capabilities ?? [], business?.provider ?? null)
          }
          aria-label="Write a WhatsApp message"
          className="input max-h-32 min-h-[2.25rem] flex-1 resize-y text-sm"
        />
        <button type="submit" className="btn-primary btn-sm" disabled={!linked || !mobile || !draft.trim() || send.isPending}>
          {send.isPending ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
          Send
        </button>
        {onBusiness && mobile && (
          <div className="flex w-full justify-end">
            <UnsubscribeLink who="this person" onUnsubscribe={() => consent.mutateAsync(false)} />
          </div>
        )}
      </form>
      )}
    </div>
  );
}
