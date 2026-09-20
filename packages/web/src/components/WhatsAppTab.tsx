import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Send } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { readMessageMedia, WhatsAppMedia } from './WhatsAppMedia';
import { composerMode, whyNoTextBox } from '../lib/whatsapp';
import { EmptyState, Skeleton, Spinner } from './ui';

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

  const { data: messages, isLoading } = useQuery({
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
    queryFn: async () => ((await api.waBizContactMessages(module, recordId)).messages.map((row) => ({
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
      }))),
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
  const canText = composerMode(business?.capabilities ?? [], Boolean(thread?.windowOpen)) === 'text';
  const linked = onBusiness && canText;

  if (isLoading) return <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {(messages ?? []).length === 0 && (
          <EmptyState
            icon={<MessageCircle className="h-8 w-8" />}
            title="No WhatsApp yet"
            body={onBusiness
              ? 'Send the first message below — it goes out from the business number.'
              : 'Ask an admin to connect the WhatsApp Business number in Admin → Integrations.'}
          />
        )}
        {(messages ?? []).map((m) => (
          <div key={m.id} className={cn('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm',
                m.direction !== 'outbound'
                  ? 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100'
                  /*
                    **A message that did not go must not look like one that
                    did.** Until 20 September every outbound line here was the
                    same green and said "sent via the business number" —
                    including six that WhatsApp had refused outright. The owner
                    was looking at a screen telling him his customer had been
                    messaged. That is the exact failure this repo already
                    warns about for the adapter, and it had been sitting in the
                    screen the whole time.
                  */
                  : m.status === 'failed'
                    ? 'bg-rose-600 text-white'
                    : m.status === 'queued'
                      ? 'bg-emerald-600/60 text-white'
                      : 'bg-emerald-600 text-white',
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
                {new Date(m.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                {/* Which number it left from — older rows may name a rep's
                    own phone, from before that route was removed. */}
                {m.direction === 'outbound' && m.sentVia && ` · ${WENT[m.status] ?? 'sent'} via ${m.sentVia}`}
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
        ))}
      </div>

      <form
        className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800"
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
      </form>
    </div>
  );
}

/**
 * What actually became of an outbound message, in a person's words.
 *
 * Not "status: failed" — a rep reads this between calls. And never the word
 * "sent" for something WhatsApp refused, which is what this screen said about
 * six messages on 20 September while the owner watched.
 */
const WENT: Record<string, string> = {
  queued: 'sending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'NOT delivered',
};
