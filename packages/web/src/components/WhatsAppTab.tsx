import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Send } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { EmptyState, Skeleton, Spinner } from './ui';

/**
 * This contact's WhatsApp history, on the contact.
 *
 * Whoever sent it. The thread is not scoped to the reader's own linked number —
 * a manager who can open the lead reads the whole conversation, and somebody who
 * cannot open the lead never gets here. Authority comes from the contact, not
 * from the phone, which is how a manager sees the history without anybody
 * borrowing an agent's session.
 *
 * Replying always goes out from the *reader's* own number, though, and the
 * button says so. Nothing here can send as somebody else.
 */
export function WhatsAppTab({ module, recordId, mobile }: {
  module: string;
  recordId: string;
  mobile: string | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const { data: me } = useQuery({ queryKey: ['whatsapp', 'me'], queryFn: () => api.whatsappMe() });
  /*
    Which road is available decides what this tab does, not which road the
    history came down. A contact messaged on the business number last week and
    from a rep's own phone in August has *one* conversation, and it reads as
    one column with a line saying which number each message went through.
  */
  const { data: business } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  const onBusiness = Boolean(business?.connected);

  const { data: messages, isLoading } = useQuery({
    queryKey: ['whatsapp', 'contact', module, recordId, onBusiness],
    queryFn: async () => (onBusiness
      ? (await api.waBizContactMessages(module, recordId)).messages.map((row) => ({
        id: String(row.id),
        direction: row.direction as 'inbound' | 'outbound',
        body: (row.body as string | null) ?? null,
        createdAt: String(row.created_at),
        sentVia: row.route === 'agent'
          ? (row.sent_by_name as string | null) ?? 'a linked phone'
          : 'the business number',
      }))
      : api.whatsappContactMessages(module, recordId)),
  });

  const send = useMutation({
    mutationFn: (text: string) => (onBusiness
      ? api.waBizSend({ to: mobile!, text, recordId }).then(() => undefined)
      : api.whatsappSend(mobile!, text).then(() => undefined)),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'contact', module, recordId] });
    },
    onError: (err: Error) => toast.error('Could not send', err.message),
  });

  // Either road counts as "can send": the business number needs no linking.
  const linked = onBusiness || me?.account?.status === 'connected';

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
              : linked
                ? 'Send the first message below — it goes out from your own number.'
                : 'Link your WhatsApp in My Profile, or ask an admin to connect the business number.'}
          />
        )}
        {(messages ?? []).map((m) => (
          <div key={m.id} className={cn('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm',
                m.direction === 'outbound'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100',
              )}
            >
              <p className="whitespace-pre-wrap break-words">
                {m.body ?? <span className="italic opacity-70">Attachment</span>}
              </p>
              <p className={cn('mt-1 text-[10px]', m.direction === 'outbound' ? 'text-emerald-50/80' : 'text-muted')}>
                {new Date(m.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                {/* Which number it left from. The one thing a shared inbox
                    cannot tell you, and the reason for per-agent linking. */}
                {m.direction === 'outbound' && m.sentVia && ` · sent via ${m.sentVia}`}
              </p>
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
              : linked ? 'Write a message' : 'Link your WhatsApp in My Profile first'
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
