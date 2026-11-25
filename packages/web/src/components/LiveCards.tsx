import { type JSX, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, BellOff, MessageCircle, Phone, PhoneMissed, PhoneOff, X } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { Avatar } from './ui';
import {
  AUTO_DISMISS_MS, chime, dismissEverywhere, listenForDismissals, mayAutoDismiss, useLiveCards,
  type CallCard,
} from '../lib/liveCards';

/** The record's newest photo, if it has one; initials otherwise. */
function usePhoto(recordId: string | null): string | null {
  const { data } = useQuery({
    queryKey: ['files', recordId],
    queryFn: () => api.files(recordId!),
    enabled: Boolean(recordId),
    staleTime: 60_000,
  });
  const photos = ((data ?? []) as Array<{ id: string; category?: string; created_at?: string }>).filter((f) => f.category === 'avatar');
  const newest = photos.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
  return newest ? `/api/files/${newest.id}` : null;
}

const SHELL = 'pointer-events-auto w-full overflow-hidden rounded-xl border border-[var(--border)] bg-white shadow-float motion-safe:animate-slide-up dark:bg-slate-900';

function CallCardView({ card }: { card: CallCard }): JSX.Element {
  const navigate = useNavigate();
  const missed = card.phase === 'missed';
  // Who is calling: looked up once per number, as the signed-in person (so another rep's lead stays unnamed).
  const { data: who } = useQuery({ queryKey: ['caller', card.number], queryFn: () => api.callerLookup(card.number), staleTime: 60_000 });
  const name = who?.kind === 'one' ? (who.label ?? card.number) : who?.kind === 'ambiguous' ? 'Several contacts' : card.number;
  const recordId = who?.kind === 'one' ? who.recordId ?? null : null;
  const module = who?.kind === 'one' ? who.module ?? 'leads' : 'leads';
  const photo = usePhoto(recordId);

  const decline = async (): Promise<void> => {
    try {
      const answer = await api.hangUpOnPhone({ recordId: recordId ?? undefined, module });
      if (!answer.sent) toast.error('Could not decline', answer.reason ?? 'Decline it on the phone.');
    } catch { toast.error('Could not decline', 'Decline it on the phone.'); }
  };
  const callBack = async (): Promise<void> => {
    try {
      const answer = await api.dialOnPhone({ to: card.number, recordId: recordId ?? undefined, module });
      if (answer.sent) dismissEverywhere(card.id);
      else toast.error('Phone did not ring', answer.reason ?? 'Open the app on the phone and try again.');
    } catch { toast.error('Phone did not ring', 'Open the app on the phone and try again.'); }
  };
  const openRecord = (): void => {
    if (missed) dismissEverywhere(card.id);
    navigate(recordId ? `/${module}?open=${recordId}` : '/calls');
  };

  return (
    <article className={SHELL} role="alertdialog" aria-label={missed ? `Missed call from ${name}` : `Incoming call from ${name}`} onKeyDown={(e) => { if (e.key === 'Escape' && missed) dismissEverywhere(card.id); }}>
      <div className="flex items-center gap-3 p-3">
        <div className="relative shrink-0">
          {!missed && <span className="absolute inset-0 rounded-full bg-emerald-400/50 motion-safe:animate-ping" aria-hidden />}
          <span className="relative block"><Avatar name={name} src={photo} size={44} /></span>
        </div>
        <div className="min-w-0 flex-1">
          <p className={missed ? 'text-xs font-medium text-negative' : 'text-xs font-medium text-positive'}>
            {missed ? <><PhoneMissed className="mr-1 inline h-3 w-3" aria-hidden />Missed call</> : <><Phone className="mr-1 inline h-3 w-3" aria-hidden />Incoming call…</>}
          </p>
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{name}</p>
          {name !== card.number && <p className="truncate text-xs text-muted">{card.number}</p>}
        </div>
        {missed && <button type="button" onClick={() => dismissEverywhere(card.id)} aria-label="Dismiss missed call" title="Dismiss" className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-3.5 w-3.5" /></button>}
      </div>
      <div className="flex gap-2 border-t border-[var(--border)] p-2">
        {missed
          ? <button type="button" className="btn-primary btn-sm" onClick={() => void callBack()}><Phone className="mr-1 h-3.5 w-3.5" aria-hidden />Call back</button>
          : card.canDecline && <button type="button" className="btn-secondary btn-sm" onClick={() => void decline()}><PhoneOff className="mr-1 h-3.5 w-3.5" aria-hidden />Decline</button>}
        <button type="button" className="btn-secondary btn-sm" onClick={openRecord}>{recordId ? 'Open record' : 'Open calls'}</button>
        {!missed && <span className="ml-auto self-center text-2xs text-muted">Answer on your phone</span>}
      </div>
    </article>
  );
}

/** The corner stack: WhatsApp messages and the ringing phone, with one mute switch. */
export function LiveCards(): JSX.Element | null {
  const cards = useLiveCards((s) => s.cards);
  const muted = useLiveCards((s) => s.muted);
  const toggleMute = useLiveCards((s) => s.toggleMute);
  const ringing = cards.some((c) => c.kind === 'call' && c.phase === 'ringing');
  useEffect(() => listenForDismissals(), []);
  // The phone rings until it is answered, declined or missed.
  useEffect(() => {
    if (!ringing) return undefined;
    chime('ring');
    const timer = window.setInterval(() => chime('ring'), 3_000);
    return () => window.clearInterval(timer);
  }, [ringing]);
  if (!cards.length) return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[65] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2" role="region" aria-label="Live notifications" aria-live="polite">
      {cards.map((card) => (card.kind === 'call' ? <CallCardView key={card.id} card={card} /> : null))}
      <button type="button" onClick={toggleMute} aria-pressed={muted} className="pointer-events-auto ml-auto flex items-center gap-1 rounded-full border border-[var(--border)] bg-white px-2.5 py-1 text-2xs text-muted shadow-xs hover:text-slate-700 dark:bg-slate-900">
        {muted ? <BellOff className="h-3 w-3" aria-hidden /> : <Bell className="h-3 w-3" aria-hidden />}{muted ? 'Sound off' : 'Sound on'}
      </button>
    </div>,
    document.body,
  );
}
