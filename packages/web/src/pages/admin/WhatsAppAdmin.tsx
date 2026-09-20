import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, MessageCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Badge, Skeleton } from '../../components/ui';

/**
 * WhatsApp, on one screen, without opening the vendor's dashboard.
 *
 * **The owner, 20 September 2026:** *"I don't understand this whatsmarketing
 * … maybe never ever in this life I would be required to open whatsmarketing."*
 *
 * So this is written for somebody who does not know what a webhook is and
 * should never need to. Every line answers a question a person actually asks —
 * *is it on, is anyone writing to us, did our messages arrive, can we reply* —
 * in that order, and names the one thing to do when the answer is bad.
 *
 * **What it deliberately does not do is hide the limit.** Four things still
 * live with the vendor or with Meta, and they are listed on the page rather
 * than left for somebody to discover at the worst possible moment. A control
 * screen that pretends to be complete is worse than one that is honest about
 * its edges.
 *
 * It reads only the CRM's own rows. No vendor call — a screen that goes blank
 * because a third party is having an afternoon is useless exactly when it is
 * needed.
 */
export default function WhatsAppAdmin(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['wa-biz', 'overview'],
    queryFn: () => api.waBizOverview(),
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="p-4 sm:p-6"><Skeleton className="h-96 w-full" /></div>;

  /*
    **A failed request is not a loading one, and this page proved it the hard
    way.** The guard used to read `isLoading || !data`, so when `/overview`
    started answering 500 — one wrong column name in its SQL — the page held
    the loading skeleton for ever. An empty grey box says nothing at all: the
    owner met it on two different URLs and could only report "what's wrong in
    here". A screen that cannot load has to say so, and name the thing that
    broke, or the next person debugs the wrong half of the CRM.
  */
  if (error || !data) {
    return (
      <div className="p-4 sm:p-6">
        <div className="card border-rose-300 p-4 dark:border-rose-900">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" />
            This page could not load
          </p>
          <p className="mt-1 text-sm text-muted">
            The CRM could not read its own WhatsApp summary. Everything else — your chats,
            sending and receiving — is unaffected; it is only this screen.
          </p>
          <p className="mt-2 break-words rounded bg-slate-100 p-2 text-2xs dark:bg-slate-800">
            {error instanceof Error ? error.message : 'No reason was given.'}
          </p>
        </div>
      </div>
    );
  }

  /*
    "Working" is not "switched on". A provider can be configured and still be
    unable to see a reply, and that is the state this CRM spent two days in
    while every screen said connected. So the headline reads the last inbound
    check, not the settings row.
  */
  const checked = data.lastCheck;
  const minutesAgo = checked ? Math.round((Date.now() - new Date(checked.at).getTime()) / 60_000) : null;
  const stale = minutesAgo === null || minutesAgo > 5;
  const healthy = data.connected && checked?.ok && !stale;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">WhatsApp</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Everything about your WhatsApp number, read from this CRM's own records.
        </p>
      </div>

      {/* 1. Is it on? */}
      <section className={cn('card flex flex-wrap items-center gap-3 p-4',
        healthy ? 'border-emerald-200 dark:border-emerald-900' : 'border-amber-300 dark:border-amber-800')}
      >
        {healthy
          ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          : <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {data.connected
              ? `Connected on ${data.businessNumber ?? 'your business number'}`
              : 'No WhatsApp provider is switched on'}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {data.provider
              ? `${label(data.provider)} · can ${data.capabilities.join(', ') || 'do nothing yet'}`
              : 'Connect one in Integrations to send or receive anything.'}
          </p>
        </div>
        <Link className="btn-secondary btn-sm" to="/admin/integrations">
          <ExternalLink className="h-3.5 w-3.5" /> Integrations
        </Link>
      </section>

      {/* 2. Are replies reaching us? The question two days were lost to. */}
      <section className="card p-4">
        <h2 className="text-sm font-semibold">Are replies reaching us?</h2>
        {!checked ? (
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
            The CRM has not checked for replies yet. If this is still here in a few minutes,
            something is wrong with the connection.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm">
              {stale
                ? <span className="text-amber-700 dark:text-amber-300">Last checked {minutesAgo} minutes ago — that is too long ago.</span>
                : <span>Checked {minutesAgo === 0 ? 'less than a minute' : `${minutesAgo} minutes`} ago.</span>}
              {' '}
              {checked.ok ? 'It reached WhatsMarketing fine.' : 'It could not reach WhatsMarketing.'}
            </p>
            {/* The poller's own words. Ugly on purpose: it is the one line that
                has explained every WhatsApp problem this CRM has had. */}
            <p className="mt-1.5 break-words rounded bg-slate-50 p-2 text-[11px] leading-relaxed text-muted dark:bg-slate-800/60">
              {checked.detail}
            </p>
          </>
        )}
      </section>

      {/* 3. The numbers, in the order somebody asks for them. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Conversations" value={data.conversations.total} hint="people who have ever written" />
        <Tile
          label="Can reply freely"
          value={data.conversations.windowOpen}
          hint="wrote within 24 hours"
        />
        <Tile label="Unread" value={data.conversations.unread} hint="waiting for somebody" warn={data.conversations.unread > 0} />
        <Tile
          label="Not linked to a contact"
          value={data.conversations.unlinked}
          hint="strangers, or numbers we do not hold"
          warn={data.conversations.unlinked > 0}
        />
      </div>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Today</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Received" value={data.messages.inboundToday} />
          <Tile label="Sent" value={data.messages.outboundToday} />
          <Tile label="Reached the phone" value={data.messages.deliveredToday} />
          <Tile label="Failed" value={data.messages.failedToday} warn={data.messages.failedToday > 0} />
        </div>
        {data.messages.failedToday > 0 && (
          <p className="mt-2 text-xs text-muted">
            A failed message keeps its reason. Open the contact's WhatsApp tab to read it —
            the CRM never shows a tick for something that did not go.
          </p>
        )}
      </section>

      {/* 4. Templates: the only thing that can be sent outside 24 hours. */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Approved wording</h2>
            <p className="mt-0.5 text-xs text-muted">
              {data.templates.approved} of {data.templates.total} approved by WhatsApp.
              {data.templates.unmapped > 0 && ` ${data.templates.unmapped} still need their blanks set.`}
            </p>
          </div>
          <Link className="btn-secondary btn-sm" to="/admin/whatsapp-templates">
            <MessageCircle className="h-3.5 w-3.5" /> Templates
          </Link>
        </div>
        {data.templates.unmapped > 0 && (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            A template with an unfilled blank cannot be sent to anybody. WhatsApp refuses it, so
            the CRM skips that person and says which blank was empty rather than sending a hole.
          </p>
        )}
      </section>

      {/* 5. The honest edge. */}
      <section className="card p-4">
        <h2 className="text-sm font-semibold">What still needs WhatsMarketing</h2>
        <p className="mt-0.5 text-xs text-muted">
          Everything else is here. These four are theirs or Meta's, not ours to move.
        </p>
        <ul className="mt-2 space-y-1">
          {data.stillTheirs.map((item) => (
            <li key={item} className="flex gap-2 text-sm text-muted">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
              {item}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Their provider ids are for the code; a person reads a name. */
function label(provider: string): string {
  const names: Record<string, string> = {
    whatsapp_whatsmarketing: 'WhatsMarketing',
    whatsapp_meta: 'Meta Cloud API',
    whatsapp_aisensy: 'AiSensy',
    whatsapp_gupshup: 'Gupshup',
  };
  return names[provider] ?? provider;
}

function Tile(
  { label: text, value, hint, warn }: { label: string; value: number; hint?: string; warn?: boolean },
): JSX.Element {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <p className="text-xs text-muted">{text}</p>
      <p className={cn('text-xl font-semibold tabular-nums', warn && 'text-amber-600')}>
        {value.toLocaleString('en-IN')}
      </p>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}
