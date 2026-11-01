import { type JSX, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { chooseWaNumber, chosenWaNumberId } from '../lib/waNumberChoice';

/**
 * Admins only: which WhatsApp number this message goes out from. "Automatic" is the lead owner's number, falling back to
 * the company number with the reason shown. Everybody else always sends from their own number, so they see nothing here.
 */
export default function SendFromPicker({ recordId }: { recordId?: string | null }): JSX.Element | null {
  const { user } = useApp();
  const [choice, setChoice] = useState(chosenWaNumberId() ?? '');
  useEffect(() => {
    const sync = () => setChoice(chosenWaNumberId() ?? '');
    window.addEventListener('ipropy:wa-number', sync);
    return () => window.removeEventListener('ipropy:wa-number', sync);
  }, []);
  const isAdmin = Boolean(user?.isAdmin);
  const { data: numbers } = useQuery({
    queryKey: ['wa-numbers', 'mine'], queryFn: () => api.waNumbersMine(), enabled: isAdmin, staleTime: 60_000,
  });
  const { data: picked } = useQuery({
    queryKey: ['wa-numbers', 'choose', recordId ?? null],
    queryFn: () => api.waNumberChoose(recordId ?? undefined),
    enabled: isAdmin && !choice,
  });
  if (!isAdmin || !numbers?.numbers.length) return null;
  const options = numbers.numbers;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-white px-3 pt-2 text-2xs text-muted dark:bg-slate-900" data-testid="send-from">
      <label>
        Send from{' '}
        <select
          className="input ml-1 inline-block h-6 w-auto py-0 text-2xs"
          value={choice}
          aria-label="Send from which WhatsApp number"
          onChange={(e) => chooseWaNumber(e.target.value)}
        >
          <option value="">Automatic{picked?.number ? ` — ${picked.number.label || picked.number.sessionName}` : ''}</option>
          {options.map((n) => (
            <option key={n.id} value={n.id}>
              {(n.label || n.sessionName) + (n.userName ? ` (${n.userName})` : '') + (n.paused ? ' — paused' : '')}
            </option>
          ))}
        </select>
      </label>
      {!choice && picked?.fallbackNote && <span role="status">{picked.fallbackNote}</span>}
      {!choice && picked?.error && <span role="alert">{picked.error}</span>}
    </div>
  );
}
