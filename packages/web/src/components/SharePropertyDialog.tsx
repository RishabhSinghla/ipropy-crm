import { type JSX, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, Search, Send } from 'lucide-react';
import { formatIndianPrice } from '@ipropy/shared';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { Modal, Skeleton, Spinner } from './ui';

/**
 * Sending a unit to the buyer you are already talking to.
 *
 * The list is **this contact's own matches first**, because that is the
 * question a rep is answering — not "which of the eight thousand units exists"
 * but "which of the ones that suit them am I sending". Search is there for the
 * unit somebody has in mind anyway, and it is the plain record search every
 * other screen uses.
 *
 * Nothing about the message is decided here. The browser names a property and
 * a line of its own; the server mints the link, reads the facts off the
 * property through the ordinary permission layers, and writes the text. A
 * screen that composed it could send a buyer a link to a floor its user was
 * never shown.
 */
export function SharePropertyDialog({ to, contactId, contactLabel, onClose, onSent }: {
  to: string;
  contactId: string | null;
  contactLabel: string;
  onClose: () => void;
  onSent: () => void;
}): JSX.Element {
  const [term, setTerm] = useState('');
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(null);
  const [note, setNote] = useState('');

  // Their matches. Only where the thread is attached to a contact — matching
  // is scored off that person's requirement and there is nothing to score
  // against on a number nobody has claimed yet.
  const { data: matched, isLoading: matching } = useQuery({
    queryKey: ['wa-biz', 'share', 'matches', contactId],
    queryFn: () => api.matchProperties('leads', contactId!, false, 8),
    enabled: Boolean(contactId) && !term.trim(),
  });

  const { data: found, isLoading: searching } = useQuery({
    queryKey: ['wa-biz', 'share', 'search', term],
    queryFn: () => api.list('properties', { search: term.trim(), pageSize: 10 }),
    enabled: term.trim().length > 1,
  });

  const options = useMemo(() => {
    if (term.trim().length > 1) {
      return (found?.rows ?? []).map((row) => ({
        id: row.id,
        label: row.label,
        detail: '',
      }));
    }
    return (matched?.matches ?? []).map((match) => ({
      id: match.propertyId,
      label: match.propertyLabel,
      // The reason it is on the list, which is the only thing that makes a
      // ranked list worth showing rather than an alphabetical one.
      detail: [
        match.price ? formatIndianPrice(match.price) : '',
        match.reasons[0] ?? '',
      ].filter(Boolean).join(' · '),
    }));
  }, [term, found, matched]);

  const share = useMutation({
    mutationFn: () => api.waBizShareProperty({
      to,
      propertyId: chosen!.id,
      contactId,
      note: note.trim() || undefined,
    }),
    onSuccess: (result) => {
      toast.success('Property sent', `${result.propertyLabel} is on its way to ${contactLabel}.`);
      onSent();
      onClose();
    },
    onError: (err: Error) => toast.error('Could not send that property', err.message),
  });

  const loading = term.trim().length > 1 ? searching : matching;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send a property to ${contactLabel}`}
      size="md"
      footer={(
        <>
          <button className="btn-secondary" onClick={onClose} disabled={share.isPending}>Close</button>
          <button
            className="btn-primary"
            disabled={!chosen || share.isPending}
            onClick={() => share.mutate()}
          >
            {share.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />} Send
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            className="input pl-8"
            aria-label="Search properties"
            placeholder={contactId ? 'Search all inventory…' : 'Search inventory…'}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
        </label>

        {!term.trim() && contactId && (
          <p className="text-2xs text-muted">Their matches, best first. Search to send anything else.</p>
        )}
        {!term.trim() && !contactId && (
          <p className="text-2xs text-muted">
            This number is not linked to a contact yet, so there is nothing to match against — search
            for the unit you have in mind.
          </p>
        )}

        <div className="max-h-64 space-y-1 overflow-y-auto">
          {loading && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
          {!loading && !options.length && (
            <p className="py-6 text-center text-xs text-muted">
              {term.trim() ? 'Nothing matched that.' : 'No matches yet — search for a unit.'}
            </p>
          )}
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setChosen({ id: option.id, label: option.label })}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm',
                chosen?.id === option.id
                  ? 'border-brand-400 bg-brand-50 dark:bg-brand-950/40'
                  : 'border-slate-200 hover:border-brand-300 dark:border-slate-700',
              )}
            >
              <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{option.label}</span>
                {option.detail && <span className="block truncate text-2xs text-muted">{option.detail}</span>}
              </span>
            </button>
          ))}
        </div>

        <label className="block">
          <span className="label">A line of your own (optional)</span>
          <textarea
            className="input min-h-[60px]"
            aria-label="A line of your own"
            placeholder="Saw this and thought of you…"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <p className="text-2xs text-muted">
          A fresh link is made for this buyer, so the views on it are theirs and it can be
          withdrawn without touching anybody else&rsquo;s.
        </p>
      </div>
    </Modal>
  );
}
