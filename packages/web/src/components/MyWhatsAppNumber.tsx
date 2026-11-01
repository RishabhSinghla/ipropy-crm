import { type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge, Skeleton } from './ui';
import { toast } from '../lib/store';

/**
 * Settings → My WhatsApp. An agent links (or re-links) their own WhatsApp number here: start it, scan the QR with their
 * phone, and see when it says Connected. It only ever touches the number assigned to the signed-in person.
 */
export function MyWhatsAppNumber(): JSX.Element {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['wa-numbers', 'mine'], queryFn: () => api.waNumbersMine(), refetchInterval: 6_000 });
  const number = mine.data?.mine ?? null;
  const connected = number?.status === 'ready';
  // The QR is only asked for while the number is not linked; it changes every ~20 seconds, so it refreshes on its own.
  const qr = useQuery({
    queryKey: ['wa-numbers', 'mine', 'qr'],
    queryFn: () => api.waMineQr(),
    enabled: Boolean(number) && !connected,
    refetchInterval: 6_000,
  });
  const control = useMutation({
    mutationFn: (action: 'start' | 'restart') => api.waMineStart(action),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wa-numbers'] }); },
    onError: (err) => toast.error('WhatsApp', err instanceof Error ? err.message : 'Something went wrong'),
  });

  if (mine.isLoading) return <Skeleton className="h-40 w-full" />;
  if (mine.error) return <p role="alert" className="text-sm">Could not load your WhatsApp number: {(mine.error as Error).message}</p>;
  if (!number) {
    return <p className="text-sm text-muted" data-testid="my-wa-none">No WhatsApp number is assigned to you yet. Ask an admin to assign one in Admin → WhatsApp numbers.</p>;
  }
  return (
    <div className="space-y-3" data-testid="my-wa">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{number.label || number.sessionName}</h3>
        <Badge>{connected ? 'Connected' : number.paused ? 'Paused' : number.statusText}</Badge>
        {number.phone && <span className="text-sm text-muted">{number.phone}</span>}
      </div>
      {connected ? (
        <p className="text-sm">Your WhatsApp is linked. Messages you send from the CRM go out from this number. Nothing more to do.</p>
      ) : (
        <div className="space-y-2">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Press <strong>Get QR code</strong> and wait a few seconds.</li>
            <li>On your phone open WhatsApp → Settings → <strong>Linked devices</strong> → <strong>Link a device</strong>.</li>
            <li>Point the phone at the code below. This page changes to <strong>Connected</strong> by itself.</li>
          </ol>
          <p className="text-sm text-muted">Logged out, or it says disconnected? Press the button and scan again. Your chats and leads are not lost.</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary btn-sm" disabled={control.isPending} onClick={() => control.mutate('start')}>Get QR code</button>
            <button className="btn-secondary btn-sm" disabled={control.isPending} onClick={() => control.mutate('restart')}>Restart</button>
          </div>
          {qr.data?.qrCode
            ? <img src={qr.data.qrCode} alt="WhatsApp pairing QR code" className="h-56 w-56 rounded border" data-testid="my-wa-qr" />
            : <p className="text-sm text-muted">No code to show yet (status: {qr.data?.status ?? number.status}). Press “Get QR code”.</p>}
        </div>
      )}
      {number.lastError && <p role="alert" className="text-sm">{number.lastError}</p>}
    </div>
  );
}
