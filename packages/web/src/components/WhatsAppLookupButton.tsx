import { type JSX, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanSearch } from 'lucide-react';
import { api, type WaLookupResult } from '../lib/api';
import { invalidateRecordQueries } from '../lib/invalidate';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { Spinner } from './ui';

/**
 * "Check WhatsApp name and photo", beside a record's phone number.
 *
 * First press asks WhatsApp (through the company number) and the answer is remembered on the server, so the icon
 * shows it at once on every later visit. Once there is an answer, pressing the icon opens a small card with the
 * photo and name and the buttons that copy them onto the record. Nothing is ever applied by itself.
 */
type Found = WaLookupResult & { lookedUpAt?: string };

export function WhatsAppLookupButton({ module, recordId, number }: { module: string; recordId: string; number: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [freshFor, setFreshFor] = useState<{ key: string; value: Found } | null>(null);
  const whose = `${module}:${recordId}:${number}`;
  const fresh = freshFor?.key === whose ? freshFor.value : null;
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // What was found before: one cheap read, no WhatsApp query.
  const stored = useQuery({
    queryKey: ['wa-lookup-stored', number],
    queryFn: () => api.waLookupStored(number),
    staleTime: 5 * 60_000,
  });
  const result: Found | null = fresh ?? stored.data?.result ?? null;

  const look = useMutation({
    mutationFn: () => api.waLookup(number),
    onSuccess: (answer) => {
      if (answer.number && !answer.number.endsWith(number.replace(/\D/g, '').slice(-10))) return;
      setFreshFor({ key: whose, value: answer });
      if (answer.status === 'on_whatsapp' || answer.status === 'not_on_whatsapp') {
        void queryClient.invalidateQueries({ queryKey: ['wa-lookup-stored', number] });
      }
      if (answer.status === 'on_whatsapp') place(); else if (answer.status !== 'not_on_whatsapp') toast.error('WhatsApp check', answer.message);
      if (answer.status === 'on_whatsapp') setOpen(true);
    },
    onError: (err: Error) => toast.error('WhatsApp check failed', err.message),
  });

  const apply = useMutation({
    mutationFn: (use: { photo: boolean; name: boolean }) => api.waLookupApply({ number, module, recordId, ...use }),
    onSuccess: (done) => {
      const parts = [done.savedName && 'WhatsApp name', done.savedPhoto && 'photo'].filter(Boolean).join(' and ');
      toast.success(parts ? `Saved ${parts}` : 'Nothing new to save');
      invalidateRecordQueries(queryClient, module, recordId);
      void queryClient.invalidateQueries({ queryKey: ['record-files'] });
      setOpen(false);
    },
    onError: (err: Error) => toast.error('Could not save', err.message),
  });

  function place(): void {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setSpot({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.right - 256, window.innerWidth - 264)) });
  }

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!card.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [open]);

  const found = result?.status === 'on_whatsapp';
  const absent = result?.status === 'not_on_whatsapp';

  const press = (event: React.MouseEvent): void => {
    event.stopPropagation();
    if (look.isPending) return;
    if (found) { place(); setOpen((v) => !v); return; }
    look.mutate();
  };

  const title = look.isPending ? 'Checking WhatsApp…'
    : found ? `On WhatsApp${result?.pushName ? `: ${result.pushName}` : ''} — click for details`
      : absent ? 'Not on WhatsApp (click to check again)' : 'Check WhatsApp name and photo';

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={press}
        title={title}
        aria-label={title}
        aria-haspopup={found ? 'dialog' : undefined}
        aria-expanded={found ? open : undefined}
        data-testid="wa-lookup-button"
        className={cn(
          'relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800',
          found ? 'text-emerald-600 dark:text-emerald-400' : absent ? 'text-slate-300 dark:text-slate-600' : 'text-slate-500 dark:text-slate-400',
        )}
      >
        {look.isPending ? <Spinner className="h-3.5 w-3.5" /> : <ScanSearch className="h-3.5 w-3.5" />}
        {found && !look.isPending && (
          result?.avatar
            ? <img src={result.avatar} alt="" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full object-cover ring-1 ring-white dark:ring-slate-900" />
            : <span className="absolute -right-0 top-0 h-2 w-2 rounded-full bg-emerald-500 ring-1 ring-white dark:ring-slate-900" />
        )}
      </button>

      {open && found && result && (
        <div
          ref={card}
          role="dialog"
          aria-label="WhatsApp name and photo"
          style={{ position: 'fixed', top: spot.top, left: spot.left, width: 256 }}
          className="popover z-50 space-y-3 p-3"
        >
          <div className="flex items-center gap-3">
            {result.avatar
              ? <img src={result.avatar} alt="WhatsApp profile" className="h-14 w-14 shrink-0 rounded-full object-cover" />
              : <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] text-slate-500 dark:bg-slate-800">No photo</span>}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{result.pushName ?? 'No name set'}</p>
              <p className="text-xs text-muted">+{result.number}</p>
              {result.lookedUpAt && <p className="text-[10px] text-muted">Checked {new Date(result.lookedUpAt).toLocaleDateString('en-IN')}</p>}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <button type="button" className="btn-secondary btn-sm" disabled={!result.avatar || apply.isPending} onClick={() => apply.mutate({ photo: true, name: false })}>Use photo as avatar</button>
            <button type="button" className="btn-secondary btn-sm" disabled={!result.pushName || apply.isPending} onClick={() => apply.mutate({ photo: false, name: true })}>Fill WhatsApp name</button>
            <button type="button" className="btn-primary btn-sm" disabled={(!result.avatar && !result.pushName) || apply.isPending} onClick={() => apply.mutate({ photo: Boolean(result.avatar), name: Boolean(result.pushName) })}>
              {apply.isPending ? <Spinner className="h-3.5 w-3.5" /> : 'Use both'}
            </button>
            <button type="button" className="text-xs text-muted hover:underline" disabled={look.isPending} onClick={() => look.mutate()}>Check again</button>
          </div>
        </div>
      )}
    </>
  );
}
