import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  AlertTriangle, Check, CheckCheck, Clock, ExternalLink, MessageCircle, Paperclip, Search, Send, Sparkles, User,
} from 'lucide-react';
import { api } from '../lib/api';
import { useWatchConversation } from '../lib/realtime';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { Avatar, Badge, EmptyState, Select, Skeleton, Spinner } from '../components/ui';

interface Conversation {
  id: string; channel: string; handle: string; contact_name: string | null;
  record_id: string | null; record_module: string | null; record_label: string | null;
  assigned_to: string | null; assigned_name: string | null;
  status: string; unread_count: number; last_message_at: string | null;
  last_message_preview: string | null; windowOpen: boolean;
  sentiment: string | null; ai_summary: string | null; ai_intent: string | null;
}

interface Message {
  id: string; direction: 'inbound' | 'outbound'; type: string; body: string | null;
  status: string; is_ai_generated: boolean; created_at: string; sent_by_name: string | null;
  template_name: string | null; error_message: string | null;
}

export default function Inbox(): JSX.Element {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('open');
  const [search, setSearch] = useState('');

  const { data: conversations, isLoading } = useQuery({
    queryKey: ['conversations', statusFilter, search],
    queryFn: () => api.conversations({ status: statusFilter, search: search || undefined, limit: 60 }),
    refetchInterval: 60_000,
  });

  const list = (conversations ?? []) as unknown as Conversation[];
  const active = conversationId ?? list[0]?.id;

  return (
    <div className="flex h-full">
      {/* Conversation list */}
      <div className={cn(
        'flex w-full shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 sm:w-80',
        conversationId && 'hidden sm:flex',
      )}>
        <div className="shrink-0 space-y-2 border-b border-slate-200 p-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-positive" />
            <h1 className="text-base font-semibold">Inbox</h1>
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'pending', label: 'Pending' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'all', label: 'All' },
              ]}
              className="ml-auto w-28 py-1 text-xs"
            />
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className="input py-1.5 pl-8 text-sm"
              placeholder="Search conversations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              icon={<MessageCircle className="h-8 w-8" />}
              title="No conversations"
              body="Inbound WhatsApp messages land here automatically."
            />
          ) : (
            list.map((conv) => (
              <button
                key={conv.id}
                onClick={() => navigate(`/inbox/${conv.id}`)}
                className={cn(
                  'flex w-full gap-3 border-b border-slate-100 p-3 text-left transition-colors dark:border-slate-800',
                  active === conv.id
                    ? 'bg-brand-50 dark:bg-brand-950/40'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                )}
              >
                <Avatar name={conv.contact_name ?? conv.handle} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {conv.contact_name ?? conv.handle}
                    </span>
                    <span className="shrink-0 text-2xs text-muted">
                      {conv.last_message_at ? relativeTime(conv.last_message_at) : ''}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">
                    {conv.last_message_preview ?? 'No messages yet'}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5">
                    {conv.unread_count > 0 && (
                      <span className="rounded-full bg-emerald-500 px-1.5 text-2xs font-semibold text-white tnum">
                        {conv.unread_count}
                      </span>
                    )}
                    {!conv.windowOpen && (
                      <span title="Outside the 24-hour window — templates only">
                        <Clock className="h-3 w-3 text-amber-500" />
                      </span>
                    )}
                    {conv.sentiment && (
                      <Badge color={
                        conv.sentiment === 'positive' ? '#22c55e'
                          : conv.sentiment === 'negative' ? '#ef4444' : '#94a3b8'
                      }>
                        {conv.sentiment}
                      </Badge>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Thread */}
      <div className={cn('min-w-0 flex-1', !conversationId && 'hidden sm:block')}>
        {active ? (
          <Thread conversationId={active} onBack={() => navigate('/inbox')} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<MessageCircle className="h-10 w-10" />}
              title="Select a conversation"
              body="Pick a thread on the left to read and reply."
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function Thread({ conversationId, onBack }: { conversationId: string; onBack: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const { aiAvailable } = useApp();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useWatchConversation(conversationId);

  const { data, isLoading } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.conversation(conversationId),
    // Messages arrive over the socket now. This is the safety net for a dropped
    // connection, not the delivery mechanism, so it is slow on purpose.
    refetchInterval: 60_000,
  });

  const { data: templates } = useQuery({
    queryKey: ['wa-templates'],
    queryFn: () => api.whatsappTemplates(),
  });

  const conv = data as unknown as (Conversation & { messages: Message[] }) | undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conv?.messages?.length]);

  const send = async (): Promise<void> => {
    if (!text.trim() && !templateName) return;
    setSending(true);
    try {
      await api.sendMessage(conversationId, templateName ? { templateName } : { text: text.trim() });
      setText('');
      setTemplateName('');
      setSuggestions([]);
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error('Could not send', (err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const loadSuggestions = async (): Promise<void> => {
    setLoadingSuggestions(true);
    try {
      const result = await api.replySuggestions(conversationId);
      setSuggestions(result.suggestions);
      if (!result.suggestions.length) toast.info('No suggestions available for this thread yet');
    } catch (err) {
      toast.error('Could not generate suggestions', (err as Error).message);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  if (isLoading || !conv) {
    return <div className="space-y-3 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  }


  return (
    <div className="flex h-full flex-col">
      {/* Thread header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <button onClick={onBack} className="btn-ghost p-1.5 sm:hidden">←</button>
        <Avatar name={conv.contact_name ?? conv.handle} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{conv.contact_name ?? conv.handle}</p>
          <p className="text-2xs text-muted tnum">{conv.handle}</p>
        </div>

        {conv.record_id && conv.record_module && (
          <Link to={`/${conv.record_module}/${conv.record_id}`} className="btn-secondary btn-sm">
            <User className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Open {conv.record_module.replace(/s$/, '')}</span>
            <ExternalLink className="h-3 w-3" />
          </Link>
        )}

        <Select
          value={conv.status}
          onChange={(status) => {
            void api.updateConversation(conversationId, { status }).then(() => {
              void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
              void queryClient.invalidateQueries({ queryKey: ['conversations'] });
            });
          }}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'pending', label: 'Pending' },
            { value: 'resolved', label: 'Resolved' },
          ]}
          className="w-28 py-1 text-xs"
        />
      </div>

      {conv.ai_summary && (
        <div className="flex shrink-0 items-start gap-2 border-b border-brand-100 bg-brand-50/60 px-4 py-2 dark:border-brand-950 dark:bg-brand-950/30">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
          <p className="text-xs text-muted">{conv.ai_summary}</p>
        </div>
      )}

      {/* Messages */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950">
        {conv.messages.map((msg) => (
          <div key={msg.id} className={cn('flex', msg.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
            <div className={cn(
              'max-w-[75%] rounded-2xl px-3.5 py-2 shadow-sm',
              msg.direction === 'outbound'
                ? 'rounded-br-md bg-emerald-600 text-white'
                : 'rounded-bl-md bg-white dark:bg-slate-800',
            )}>
              {msg.template_name && (
                <p className={cn(
                  'mb-1 text-2xs font-medium uppercase tracking-wide',
                  msg.direction === 'outbound' ? 'text-emerald-100' : 'text-muted',
                )}>
                  Template · {msg.template_name}
                </p>
              )}
              <p className="whitespace-pre-wrap text-sm">{msg.body ?? `[${msg.type}]`}</p>
              <div className={cn(
                'mt-1 flex items-center justify-end gap-1 text-[10px]',
                msg.direction === 'outbound' ? 'text-emerald-100' : 'text-muted',
              )}>
                {msg.is_ai_generated && <Sparkles className="h-2.5 w-2.5" />}
                <span className="tnum">
                  {new Date(msg.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                {msg.direction === 'outbound' && (
                  msg.status === 'read' ? <CheckCheck className="h-3 w-3" />
                    : msg.status === 'delivered' ? <CheckCheck className="h-3 w-3 opacity-60" />
                    : msg.status === 'failed' ? <AlertTriangle className="h-3 w-3 text-red-200" />
                    : <Check className="h-3 w-3 opacity-60" />
                )}
              </div>
              {msg.error_message && (
                <p className="mt-1 text-[10px] text-red-200">{msg.error_message}</p>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        {!conv.windowOpen && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span>
              This conversation is outside the 24-hour window. Send an approved template to re-open it.
            </span>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => { setText(s); setSuggestions([]); }}
                className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs text-brand-700 transition-colors hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-300"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {!conv.windowOpen && templates && (
          <Select
            value={templateName}
            onChange={setTemplateName}
            placeholder="— Choose a template —"
            options={templates.map((t) => ({
              value: String((t as { name: string }).name),
              label: String((t as { name: string }).name).replace(/_/g, ' '),
            }))}
            className="mb-2 text-sm"
          />
        )}

        <div className="flex items-end gap-2">
          <textarea
            className="input resize-none"
            rows={2}
            placeholder={conv.windowOpen ? 'Type a message…' : 'Free-form replies are blocked outside the window'}
            value={text}
            disabled={!conv.windowOpen && !templateName}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
          />
          {aiAvailable && conv.windowOpen && (
            <button
              onClick={() => void loadSuggestions()}
              disabled={loadingSuggestions}
              className="btn-secondary shrink-0 px-2.5 py-2.5"
              title="Suggest replies"
            >
              {loadingSuggestions ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4 text-brand-500" />}
            </button>
          )}
          <button
            onClick={() => void send()}
            disabled={sending || (!text.trim() && !templateName)}
            className="btn-primary shrink-0 px-3 py-2.5"
          >
            {sending ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
