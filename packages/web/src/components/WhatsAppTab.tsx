import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, ExternalLink, MessageCircle, Send } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { readMessageMedia, WhatsAppMedia } from './WhatsAppMedia';
import { UnsubscribedPanel, UnsubscribeLink } from './WhatsAppConsent';
import { bubbleTime, composerMode, dayLabel, outboundTone, wentOut, whyNoTextBox } from '../lib/whatsapp';
import { EmptyState, Select, Skeleton, Spinner } from './ui';

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
        sentVia: row.route === 'agent'
          ? (row.sent_by_name as string | null) ?? 'a linked phone'
          : 'the business number',
        status: String(row.status ?? ''),
        error: (row.error_message as string | null) ?? null,
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

  const send = useMutation({
    mutationFn: (text: string) => api.waBizSend({ to: mobile!, text, recordId }).then(() => undefined),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'contact', module, recordId] });
    },
    onError: (err: Error) => toast.error('Could not send', err.message),
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
  const linked = onBusiness && mode === 'text';

  /*
    **When a free reply cannot go, an approved template still can.** Until now
    this tab answered a shut window with a dead box and nothing else, so a rep
    on a record had no way to reach the customer at all and had to go and find
    the Chats screen. Same controls as that screen, same server call — the
    blanks are filled by `resolveTemplate` as the person asking, so this cannot
    put a value in front of a customer that the rep was not allowed to read.
  */
  const [templateId, setTemplateId] = useState('');
  const { data: templates } = useQuery({
    queryKey: ['wa-biz', 'templates', 'saved'],
    queryFn: () => api.waBizSavedTemplates(),
    enabled: onBusiness && mode === 'template',
  });
  const { data: preview } = useQuery({
    queryKey: ['wa-biz', 'template-preview', templateId, module, recordId],
    queryFn: () => api.waBizTemplatePreview(templateId, module, recordId),
    enabled: Boolean(templateId),
  });
  const sendTemplate = useMutation({
    mutationFn: () => api.waBizSendTemplate({ templateId, module, recordId, to: mobile! }),
    onSuccess: () => {
      setTemplateId('');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'contact', module, recordId] });
      void queryClient.invalidateQueries({ queryKey: ['wa-biz', 'thread', mobile, module, recordId] });
    },
    onError: (err: Error) => toast.error('Could not send the template', err.message),
  });

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

  if (isLoading) return <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;

  const conversation = messages ?? [];


  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/*
        The way back to the same conversation on the WhatsApp screen, where the
        whole team's queue is — the mirror of "Open the full record" there.
      */}
      <div className="flex justify-end border-b border-slate-200 bg-white px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900">
        <Link
          to={`/whatsapp/chats?record=${recordId}`}
          className="inline-flex items-center gap-1.5 text-2xs font-semibold text-muted transition-colors hover:text-brand-600"
        >
          <ExternalLink className="h-3 w-3" />
          Open in WhatsApp
        </Link>
      </div>
      {/*
        A tinted canvas, the same one the Chats screen uses, so a white
        incoming bubble reads as a bubble. On white the thread looked like a
        page with faint boxes on it rather than like a chat.
      */}
      <div ref={bottomOf} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-slate-100 p-4 dark:bg-slate-950">
        {conversation.length === 0 && (
          <EmptyState
            icon={<MessageCircle className="h-8 w-8" />}
            title="No WhatsApp yet"
            body={onBusiness
              ? 'Send the first message below — it goes out from the business number.'
              : 'Ask an admin to connect the WhatsApp Business number in Admin → Integrations.'}
          />
        )}
        {conversation.map((m, index) => (
          <div key={m.id}>
          {/* The date once, down the middle, the way WhatsApp does it —
              instead of on all forty bubbles from one afternoon. */}
          {dayLabel(m.createdAt) !== (index > 0 ? dayLabel(conversation[index - 1]!.createdAt) : null) && (
            <div className="flex justify-center py-2">
              <span className="rounded-md bg-white px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
                {dayLabel(m.createdAt)}
              </span>
            </div>
          )}
          <div className={cn('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm',
                /*
                  **A message that did not go must not look like one that
                  did.** Until 20 September every outbound line here was the
                  same green and said "sent via the business number" —
                  including six that WhatsApp had refused outright. The owner
                  was looking at a screen telling him his customer had been
                  messaged. `outboundTone` is the one place that decides, so
                  this tab and the Chats screen cannot disagree about what a
                  refused message looks like.
                */
                m.direction !== 'outbound'
                  ? 'bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100'
                  : cn(outboundTone(m.status), 'text-white'),
              )}
            >
              {(() => {
                const media = readMessageMedia(m.media);
                return media ? (
                  <div className="mb-1 min-w-[12rem]">
                    <WhatsAppMedia media={media} dark={m.direction === 'outbound'} />
                  </div>
                ) : null;
              })()}
              {(m.body || !readMessageMedia(m.media)) && (
                <p className="whitespace-pre-wrap break-words">
                  {m.body ?? <span className="italic opacity-70">Attachment</span>}
                </p>
              )}
              <p className={cn('mt-1 text-[10px]', m.direction === 'outbound' ? 'text-white/80' : 'text-muted')}>
                {bubbleTime(m.createdAt)}
                {/* Which number it left from — older rows may name a rep's
                    own phone, from before that route was removed. */}
                {m.direction === 'outbound' && m.sentVia
                  && ` · ${m.status === 'failed' ? 'NOT delivered' : wentOut(m.status)} via ${m.sentVia}`}
              </p>
              {/*
                The reason, in the provider's own words. "Not delivered" alone
                sends somebody hunting; "outside the 24-hour window" is a thing
                a person can act on in ten seconds.
              */}
              {m.direction === 'outbound' && m.status === 'failed' && (
                <p className="mt-1 rounded bg-white/15 px-1.5 py-1 text-[10px] leading-snug text-white">
                  <strong>Not delivered.</strong> {m.error ?? 'WhatsApp gave no reason.'}
                </p>
              )}
            </div>
          </div>
          </div>
        ))}
      </div>

      {/*
        The window has shut, so nothing free may go — but an approved template
        still can, and this is where a rep already is. Without it the only way
        to reach the customer from a record was to leave the record.
      */}
      {optedOut && (
        <div className="border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <UnsubscribedPanel who="This person" onSubscribeAgain={() => consent.mutateAsync(true)} />
        </div>
      )}

      {!optedOut && onBusiness && mode === 'template' && mobile && (
        <div className="space-y-2 border-t border-slate-200 bg-amber-50 px-3 py-2 dark:border-slate-800 dark:bg-amber-950/40">
          <p className="flex items-center gap-1.5 text-xs text-amber-900 dark:text-amber-200">
            <Clock className="h-3.5 w-3.5" />
            {whyNoTextBox(business?.capabilities ?? [], business?.provider ?? null)}
          </p>
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
          {preview && (
            <div className="rounded-md bg-white/70 p-2 text-xs dark:bg-slate-900/60">
              <p className="whitespace-pre-wrap">{preview.preview}</p>
              {preview.missing.length > 0 && (
                // Named, not counted: this is fixable in ten seconds on the
                // record itself, and "failed" would send somebody hunting.
                <p className="mt-1 font-semibold text-rose-700 dark:text-rose-300">
                  {preview.missing.map((gap) => `{{${gap.slot}}} ${gap.reason}`).join('; ')}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!optedOut && (
      <form
        className="flex flex-wrap items-end gap-2 border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) send.mutate(draft.trim()); }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={1}
          disabled={!linked || !mobile}
          placeholder={
            !mobile ? 'This contact has no mobile number'
              : !onBusiness ? 'No WhatsApp Business number is connected yet'
                : linked ? 'Write a message'
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
