/**
 * WhatsApp, as its own place in the CRM.
 *
 * The pieces already existed and were scattered: linking a phone lived in
 * personal Settings, and the conversations lived in the Inbox alongside email
 * and everything else. Somebody who wants to "do WhatsApp" had to know both.
 * This is the one door — scan here, then talk here.
 *
 * Not an iframe and not a second implementation. The list and the thread come
 * from the same API the Inbox uses, and the thread is literally the Inbox's
 * component, so a fix to one is a fix to both. What is different is the shape:
 * this screen is the two-pane WhatsApp Web layout, and it knows how to be
 * unlinked, which the Inbox has no reason to.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { Loader2, MessageCircle, Search, Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { Avatar, Badge, EmptyState, Skeleton, Spinner } from '../components/ui';
import { Thread } from './Inbox';

interface Conversation {
  id: string; channel: string; handle: string; contact_name: string | null;
  record_id: string | null; record_module: string | null; record_label: string | null;
  status: string; unread_count: number; last_message_at: string | null;
  last_message_preview: string | null;
}

interface WaLink {
  id: string; userId: string; status: 'pending' | 'connected' | 'logged_out' | 'disabled';
  handle: string | null; qr: string | null; lastError: string | null;
  sentToday: number; dailyCap: number;
}

export default function WhatsApp(): JSX.Element {
  const { user } = useApp();
  const [active, setActive] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const { data: linkData, isLoading: loadingLink, refetch } = useQuery({
    queryKey: ['whatsapp-links'],
    queryFn: () => api.whatsappLinks(),
    // Only while a code is on screen; WhatsApp rotates it every twenty seconds
    // or so, and a stale code scans as nothing and reads as a broken feature.
    refetchInterval: (q) => {
      const links = (q.state.data as { links?: WaLink[] } | undefined)?.links ?? [];
      return links.some((l) => l.status === 'pending') ? 3000 : false;
    },
  });

  const mine = (linkData?.links ?? []).find((l) => l.userId === user?.id) ?? null;
  const connected = mine?.status === 'connected';

  if (loadingLink) {
    return <div className="space-y-3 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;
  }

  if (!linkData?.enabled || !connected) {
    return <ConnectPanel link={mine} enabled={Boolean(linkData?.enabled)} onChanged={() => void refetch()} />;
  }

  return (
    <div className="flex h-full">
      <div className={cn(
        'flex w-full shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 sm:w-80',
        active && 'hidden sm:flex',
      )}>
        <div className="shrink-0 space-y-2 border-b border-slate-200 p-3 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-positive" />
            <h1 className="text-base font-semibold">WhatsApp</h1>
            <span className="ml-auto flex items-center gap-1.5 text-2xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {mine?.handle ?? 'Linked'}
            </span>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className="input py-1.5 pl-8 text-sm"
              placeholder="Search chats…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <ChatList search={search} active={active} onPick={setActive} />
        <div className="shrink-0 border-t border-slate-200 px-3 py-2 text-2xs text-muted dark:border-slate-800">
          {mine ? `${mine.sentToday} of ${mine.dailyCap} automated messages sent today` : null}
        </div>
      </div>

      <div className={cn('min-w-0 flex-1', !active && 'hidden sm:block')}>
        {active
          ? <Thread conversationId={active} onBack={() => setActive(null)} />
          : (
            <EmptyState
              icon={<MessageCircle className="h-8 w-8" />}
              title="Pick a chat"
              body="Your WhatsApp conversations with leads and customers are on the left."
            />
          )}
      </div>
    </div>
  );
}

/** The chat list. Same endpoint the Inbox uses, narrowed to this channel. */
function ChatList({ search, active, onPick }: {
  search: string; active: string | null; onPick: (id: string) => void;
}): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['conversations', 'whatsapp', search],
    queryFn: () => api.conversations({
      channel: 'whatsapp', status: 'all', search: search || undefined, limit: 100,
    }),
    // Messages arrive over the socket; this is the dropped-connection net.
    refetchInterval: 60_000,
  });

  const list = (data ?? []) as unknown as Conversation[];

  if (isLoading) {
    return <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>;
  }
  if (!list.length) {
    return (
      <EmptyState
        icon={<MessageCircle className="h-8 w-8" />}
        title="No chats yet"
        body="Conversations with people already in your CRM appear here. Personal chats stay on your phone."
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {list.map((c) => (
        <button
          key={c.id}
          onClick={() => onPick(c.id)}
          className={cn(
            'flex w-full gap-3 border-b border-slate-100 p-3 text-left transition-colors dark:border-slate-800',
            active === c.id ? 'bg-brand-50 dark:bg-brand-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
          )}
        >
          <Avatar name={c.contact_name ?? c.handle} size={38} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="truncate text-sm font-medium">{c.contact_name ?? c.handle}</p>
              {c.last_message_at && (
                <span className="ml-auto shrink-0 text-2xs text-muted">{relativeTime(c.last_message_at)}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <p className="truncate text-xs text-muted">{c.last_message_preview ?? 'No messages yet'}</p>
              {c.unread_count > 0 && (
                <Badge color="#22c55e" className="ml-auto shrink-0">{c.unread_count}</Badge>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * Everything before there is a chat to show: switched off, not linked, waiting
 * for a code, or thrown off by the phone.
 *
 * Deliberately the whole screen rather than a strip at the top. This is the
 * WhatsApp Web moment — a person is holding a phone, about to point it at a
 * monitor — and burying the code under a chat list they do not have yet helps
 * nobody.
 */
function ConnectPanel({ link, enabled, onChanged }: {
  link: WaLink | null; enabled: boolean; onChanged: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createWhatsappLink({}),
    onSuccess: () => { onChanged(); void qc.invalidateQueries({ queryKey: ['whatsapp-links'] }); },
    onError: (e: Error) => toast.error('Could not start linking', e.message),
  });

  const waiting = link?.status === 'pending';

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <MessageCircle className="h-7 w-7 text-positive" />
          <div>
            <h1 className="text-lg font-semibold">WhatsApp</h1>
            <p className="text-sm text-muted">
              Use your own WhatsApp inside the CRM, the same way you use it on a laptop.
            </p>
          </div>
        </div>

        {!enabled ? (
          <div className="card p-6 text-sm text-muted">
            <p className="font-medium text-slate-900 dark:text-slate-100">Not switched on yet</p>
            <p className="mt-2">
              An administrator turns this on in Admin, Integrations, under
              &ldquo;WhatsApp via linked phone&rdquo;. It takes about five minutes and the
              CRM generates everything it needs.
            </p>
          </div>
        ) : waiting && link?.qr ? (
          <div className="card flex flex-col gap-6 p-6 sm:flex-row sm:items-center">
            <img src={link.qr} alt="QR code to link WhatsApp" className="mx-auto h-56 w-56 shrink-0 rounded-lg bg-white p-2" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Scan this with the phone whose number you want to use</p>
              <ol className="mt-3 space-y-1.5 text-sm text-muted">
                <li>1. Open WhatsApp on that phone</li>
                <li>2. Settings, then Linked devices</li>
                <li>3. Link a device</li>
                <li>4. Point the camera at this code</li>
              </ol>
              <p className="mt-3 text-xs text-muted">
                The code changes every few seconds on its own. If the camera misses it, wait for the next one.
              </p>
            </div>
          </div>
        ) : waiting ? (
          <div className="card flex items-center gap-3 p-6 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>
              Waiting for a code. It is produced by the bridge on the office machine, so if
              nothing appears within a minute, that program is probably not running.
            </span>
          </div>
        ) : (
          <div className="card space-y-4 p-6">
            {link?.status === 'logged_out' && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Your phone removed this link{link.lastError ? `: ${link.lastError}` : '.'} Link it again to carry on.
              </p>
            )}
            <div className="flex items-start gap-3">
              <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-muted" />
              <div className="text-sm text-muted">
                <p className="font-medium text-slate-900 dark:text-slate-100">Link your phone</p>
                <p className="mt-1">
                  Your phone stays in charge. The CRM shows the same chats it does, and
                  messages you send from here go out from your number. Only chats with
                  people already in the CRM are stored; personal ones stay on the phone.
                </p>
              </div>
            </div>
            <button className="btn-primary btn-sm" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Spinner /> : <MessageCircle className="h-3.5 w-3.5" />}
              Link my WhatsApp
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
