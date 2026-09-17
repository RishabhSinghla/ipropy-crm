import { type JSX, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Search, Send, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { Avatar, EmptyState, Skeleton, Spinner } from '../components/ui';

/**
 * The agent's WhatsApp conversations.
 *
 * What this screen shows is *their* linked number's threads — the server scopes
 * every query to the signed-in user's own account, so there is nothing to get
 * wrong here. A manager reading somebody else's history does it through the
 * contact, where the CRM's own permissions apply.
 *
 * The thread is read from the CRM's stored copy, never from the phone. That is
 * what makes it survive a disconnect, a new laptop, or the agent leaving.
 */

function timeOf(value: string | null): string {
  if (!value) return '';
  const at = new Date(value);
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  return sameDay
    ? at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export default function Chats(): JSX.Element {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  // `?to=<digits>` is how the WhatsApp icon beside a phone number arrives here.
  const wanted = (params.get('to') ?? '').replace(/\D/g, '');
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const { data: me } = useQuery({ queryKey: ['whatsapp', 'me'], queryFn: () => api.whatsappMe() });
  const { data: conversations, isLoading } = useQuery({
    queryKey: ['whatsapp', 'conversations', unreadOnly],
    queryFn: () => api.whatsappConversations(unreadOnly),
    // A thread arriving while somebody is reading is the point of the screen.
    refetchInterval: 15_000,
  });

  const { data: messages } = useQuery({
    queryKey: ['whatsapp', 'messages', active],
    queryFn: () => api.whatsappMessages(active!),
    enabled: Boolean(active),
    refetchInterval: active ? 10_000 : false,
  });

  const { data: unmatched } = useQuery({
    queryKey: ['whatsapp', 'unmatched'],
    queryFn: () => api.whatsappUnmatched(),
  });

  const send = useMutation({
    mutationFn: async (text: string) => {
      const thread = (conversations ?? []).find((c) => c.id === active);
      if (!thread) throw new Error('Open a conversation first.');
      return api.whatsappSend(thread.handle, text);
    },
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'messages', active] });
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] });
    },
    onError: (err: Error) => toast.error('Could not send', err.message),
  });

  /*
    Arriving from a number rather than from a thread. The handle is matched on
    its last ten digits, the same rule contact matching uses, because a thread
    stores whatever WhatsApp said and a record stores whatever a rep typed. No
    thread yet is a normal answer: the list simply opens unselected.
  */
  useEffect(() => {
    if (!wanted || active || !conversations?.length) return;
    const tail = wanted.slice(-10);
    const found = conversations.find((c) => c.handle.replace(/\D/g, '').endsWith(tail));
    if (found) setActive(found.id);
  }, [wanted, active, conversations]);

  // Opening a thread is what marks it read — receiving it is not.
  useEffect(() => {
    if (!active) return;
    void api.whatsappMarkRead(active)
      .then(() => queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] }))
      .catch(() => undefined);
  }, [active, queryClient]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length, active]);

  const needle = query.trim().toLowerCase();
  const shown = (conversations ?? []).filter((c) =>
    !needle
    || (c.record_label ?? c.contact_name ?? '').toLowerCase().includes(needle)
    || c.handle.includes(needle)
    || (c.last_message_preview ?? '').toLowerCase().includes(needle));

  const thread = (conversations ?? []).find((c) => c.id === active) ?? null;

  if (!me?.account) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<MessageCircle className="h-8 w-8" />}
          title="Link your WhatsApp first"
          body="Chats shows the conversations on your own WhatsApp number. Link it in My Profile → WhatsApp."
          action={<Link className="btn-primary btn-sm" to="/settings">Open My Profile</Link>}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 dark:border-slate-800">
        <div className="space-y-2 border-b border-slate-100 p-3 dark:border-slate-800">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="input h-8 w-full pl-8 text-xs"
            />
          </div>
          <div className="flex gap-1">
            {([[false, 'All chats'], [true, 'Unread']] as const).map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={unreadOnly === value}
                onClick={() => setUnreadOnly(value)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-semibold transition-colors',
                  unreadOnly === value
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-200'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {(unmatched?.length ?? 0) > 0 && (
          <Link
            to="/settings"
            className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <UserPlus className="h-3.5 w-3.5 shrink-0" />
            {unmatched!.length} message{unmatched!.length === 1 ? '' : 's'} from numbers not in the CRM
          </Link>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>}
          {!isLoading && shown.length === 0 && (
            <p className="p-4 text-center text-xs text-muted">
              {needle ? `Nothing matches “${query.trim()}”.` : 'No conversations yet.'}
            </p>
          )}
          {shown.map((c) => {
            const name = c.record_label ?? c.contact_name ?? c.handle;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setActive(c.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition-colors dark:border-slate-800',
                  active === c.id ? 'bg-brand-50 dark:bg-brand-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                )}
              >
                <Avatar name={name} size={34} className="text-[11px]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{name}</span>
                    <span className="shrink-0 text-[10px] text-muted tabular-nums">{timeOf(c.last_message_at)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted">{c.last_message_preview ?? c.handle}</span>
                    {c.unread_count > 0 && (
                      <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">
                        {c.unread_count}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!thread ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              icon={<MessageCircle className="h-8 w-8" />}
              title="Pick a conversation"
              body="Your WhatsApp threads appear on the left. The CRM keeps its own copy, so they stay here even if your phone disconnects."
            />
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
              <Avatar name={thread.record_label ?? thread.handle} size={32} className="text-[11px]" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{thread.record_label ?? thread.contact_name ?? thread.handle}</p>
                <p className="text-xs text-muted">{thread.handle}</p>
              </div>
              {/* The contact is where everything else about this person lives —
                  calls, notes, follow-ups. One link rather than a second copy. */}
              {thread.record_id && thread.record_module && (
                <Link
                  className="btn-secondary btn-sm ml-auto"
                  to={`/${thread.record_module}/${thread.record_id}`}
                >
                  Open contact
                </Link>
              )}
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950/40">
              {(messages ?? []).map((m) => (
                <div key={m.id} className={cn('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm',
                      m.direction === 'outbound'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100',
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.body ?? <span className="italic opacity-70">Attachment</span>}</p>
                    <p className={cn('mt-1 text-[10px] tabular-nums', m.direction === 'outbound' ? 'text-emerald-50/80' : 'text-muted')}>
                      {timeOf(m.created_at)}
                      {m.direction === 'outbound' && ` · ${m.status}`}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>

            <form
              className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800"
              onSubmit={(e) => { e.preventDefault(); if (draft.trim()) send.mutate(draft.trim()); }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={1}
                placeholder="Write a message"
                aria-label="Write a message"
                className="input max-h-32 min-h-[2.25rem] flex-1 resize-y text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (draft.trim()) send.mutate(draft.trim());
                  }
                }}
              />
              <button type="submit" className="btn-primary btn-sm" disabled={!draft.trim() || send.isPending}>
                {send.isPending ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
                Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
