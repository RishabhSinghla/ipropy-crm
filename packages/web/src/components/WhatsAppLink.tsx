import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageCircle, Power, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { Spinner } from './ui';

/**
 * Linking this agent's own WhatsApp, in My Profile.
 *
 * One number per person, theirs, and nobody else's: the screen never names an
 * account, it asks the server what *this* signed-in person has linked.
 *
 * The QR arrives as a picture already drawn. WhatsApp's payload is, briefly,
 * the thing that links a device to somebody's account — keeping it off the page
 * as text is worth the round trip, and it saves every user downloading a QR
 * library for a screen most of them open once.
 */

const TONE: Record<string, { label: string; className: string; dot: string }> = {
  connected: {
    label: 'Connected',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200',
    dot: 'bg-emerald-500',
  },
  qr: {
    label: 'Waiting for you to scan',
    className: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
    dot: 'bg-amber-500',
  },
  connecting: {
    label: 'Connecting',
    className: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
    dot: 'bg-amber-500',
  },
  pairing: {
    label: 'Pairing',
    className: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
    dot: 'bg-amber-500',
  },
  error: {
    label: 'Disconnected — reconnect required',
    className: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200',
    dot: 'bg-red-500',
  },
  disconnected: {
    label: 'Not linked',
    className: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200',
    dot: 'bg-slate-400',
  },
};

function when(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function WhatsAppLink(): JSX.Element {
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['whatsapp', 'me'],
    queryFn: () => api.whatsappMe(),
    /*
      Polled only while there is something to watch. A QR expires and is
      replaced every twenty seconds or so, and the status moves on its own once
      the phone scans — so the screen has to keep asking. Once connected there
      is nothing to poll for, and a request every two seconds for every signed-in
      agent all day is a cost with no reader.
    */
    refetchInterval: (query) => {
      const status = query.state.data?.account?.status;
      return status && status !== 'connected' && status !== 'disconnected' ? 2_000 : false;
    },
  });

  const account = data?.account ?? null;
  const status = account?.status ?? 'disconnected';
  const tone = TONE[status] ?? TONE.disconnected!;

  // Tell somebody the moment it works, rather than leaving them staring at a QR
  // wondering whether the scan took.
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    if (status === 'connected' && !announced) {
      setAnnounced(true);
      setLinking(false);
      toast.success('WhatsApp linked', 'Messages will appear in Chats.');
    }
    if (status !== 'connected' && announced) setAnnounced(false);
  }, [status, announced]);

  const link = async (): Promise<void> => {
    setLinking(true);
    try {
      await api.whatsappLink();
      await queryClient.invalidateQueries({ queryKey: ['whatsapp', 'me'] });
    } catch (err) {
      setLinking(false);
      toast.error('Could not start linking', (err as Error).message);
    }
  };

  const unlink = async (): Promise<void> => {
    try {
      await api.whatsappUnlink();
      await queryClient.invalidateQueries({ queryKey: ['whatsapp', 'me'] });
      toast.success('WhatsApp unlinked', 'Everything already saved stays on your contacts.');
    } catch (err) {
      toast.error('Could not unlink', (err as Error).message);
    }
  };

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <MessageCircle className="h-4 w-4 text-emerald-600" />
          My WhatsApp
        </h2>
        <p className="mt-1 text-xs text-muted">
          Link your own number to send and receive inside the CRM. Messages you send go out
          from your number, and only you can use this link.
        </p>
      </div>

      <div className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium', tone.className)}>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', tone.dot)} />
        {tone.label}
        {account?.phoneNumber && <span className="font-semibold">· {account.phoneNumber}</span>}
        {account?.displayName && <span className="text-muted">· {account.displayName}</span>}
      </div>

      {account?.isEnabled === false && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          An administrator has switched WhatsApp off for your account.
        </p>
      )}

      {data?.qr && status !== 'connected' && (
        <div className="rounded-xl border border-slate-200 p-4 text-center dark:border-slate-700">
          <img src={data.qr} alt="Scan this with WhatsApp on your phone" className="mx-auto h-64 w-64 rounded-lg" />
          <ol className="mx-auto mt-3 max-w-xs space-y-1 text-left text-xs text-muted">
            <li>1. Open WhatsApp on your phone.</li>
            <li>2. Settings → Linked devices → Link a device.</li>
            <li>3. Point your phone at this code.</li>
          </ol>
          <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            The code refreshes on its own until you scan it.
          </p>
        </div>
      )}

      {account && status === 'connected' && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted">Connected since</dt>
          <dd className="tabular-nums">{when(account.lastConnectedAt)}</dd>
          <dt className="text-muted">Last sync</dt>
          <dd className="tabular-nums">{when(account.lastSyncedAt)}</dd>
        </dl>
      )}

      {account?.lastError && status !== 'connected' && (
        <p className="text-xs text-red-700 dark:text-red-300">{account.lastError}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {status !== 'connected' && (
          <button className="btn-primary btn-sm" disabled={linking || account?.isEnabled === false} onClick={() => void link()}>
            {linking ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
            {account ? 'Reconnect WhatsApp' : 'Link WhatsApp'}
          </button>
        )}
        {account && (
          <button className="btn-secondary btn-sm" onClick={() => void unlink()}>
            <Power className="h-3.5 w-3.5" />
            Unlink
          </button>
        )}
      </div>

      {account && (
        <p className="text-[11px] text-muted">
          Unlinking only ends the connection. Every message already saved stays on the contact
          it belongs to.
        </p>
      )}
    </div>
  );
}
