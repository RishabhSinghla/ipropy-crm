import { type JSX, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Search, UserRound } from 'lucide-react';
import { api, type WaLookupResult } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { Spinner } from '../components/ui';

/**
 * WhatsApp Lookup — who is this number on WhatsApp?
 *
 * Paste a number, press Enter: the profile name and picture, or "not on WhatsApp", or a plain note that WhatsApp is
 * not connected. One number at a time by design (every lookup is a query WhatsApp sees from the company's number), so
 * there is no list box. If the number belongs to a CRM contact the person may open, a button saves the picture and
 * name onto that contact — a separate, deliberate press.
 */
export default function WhatsAppLookup(): JSX.Element {
  const isAdmin = Boolean(useApp().user?.isAdmin);
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [result, setResult] = useState<WaLookupResult | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);

  const look = useMutation({
    mutationFn: (number: string) => api.waLookup(number),
    onSuccess: (answer) => {
      setResult(answer);
      setSaved({});
      void queryClient.invalidateQueries({ queryKey: ['wa-lookup-log'] });
    },
    onError: (err: Error) => toast.error('Lookup failed', err.message),
  });

  const save = useMutation({
    mutationFn: (recordId: string) => api.waLookupSave(result!.number!, recordId),
    onSuccess: (done, recordId) => {
      const parts = [done.savedName && 'WhatsApp name', done.savedPhoto && 'photo'].filter(Boolean).join(' and ');
      setSaved((previous) => ({ ...previous, [recordId]: parts ? `Saved ${parts}.` : 'Nothing new to save.' }));
      void queryClient.invalidateQueries({ queryKey: ['record'] });
      void queryClient.invalidateQueries({ queryKey: ['record-files'] });
    },
    onError: (err: Error) => toast.error('Could not save', err.message),
  });

  const { data: log } = useQuery({ queryKey: ['wa-lookup-log'], queryFn: () => api.waLookupLog(), enabled: isAdmin, refetchOnWindowFocus: false });

  const submit = (): void => {
    const value = text.trim();
    if (value && !look.isPending) look.mutate(value);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-lg font-semibold">WhatsApp Lookup</h1>
        <p className="text-sm text-muted">Paste a phone number and press Enter to see the name and photo on WhatsApp. One number at a time.</p>
      </div>

      <form className="card flex items-center gap-2 p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <input
          ref={input}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          inputMode="tel"
          aria-label="Phone number to look up"
          placeholder="+91 98912 22206"
          className="input flex-1"
        />
        <button type="submit" className="btn-primary btn-sm" disabled={!text.trim() || look.isPending}>
          {look.isPending ? <Spinner className="h-3.5 w-3.5" /> : 'Look up'}
        </button>
      </form>

      {result && <ResultCard result={result} saved={saved} saving={save.isPending} onSave={(id) => save.mutate(id)} />}

      {isAdmin && log && log.rows.length > 0 && (
        <div className="card overflow-x-auto">
          <h2 className="border-b border-[var(--border)] px-3 py-2 text-sm font-semibold">Recent lookups (admins only)</h2>
          <table className="w-full text-xs">
            <thead className="list-head"><tr><th className="px-3 py-1.5 text-left">When</th><th className="px-3 py-1.5 text-left">Who</th><th className="px-3 py-1.5 text-left">Number</th><th className="px-3 py-1.5 text-left">Result</th></tr></thead>
            <tbody>
              {log.rows.slice(0, 30).map((row, index) => (
                <tr key={index} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5">{new Date(row.created_at).toLocaleString('en-IN')}</td>
                  <td className="px-3 py-1.5">{row.user_name ?? '—'}</td>
                  <td className="px-3 py-1.5">+{row.number}</td>
                  <td className="px-3 py-1.5">{row.result.replace(/_/g, ' ')}{row.push_name ? ` · ${row.push_name}` : ''}{row.from_cache ? ' (remembered)' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResultCard({ result, saved, saving, onSave }: {
  result: WaLookupResult; saved: Record<string, string>; saving: boolean; onSave: (recordId: string) => void;
}): JSX.Element {
  const problem = result.status === 'disconnected' || result.status === 'rate_limited' || result.status === 'invalid';
  return (
    <div className="card space-y-3 p-4" role="status" data-testid="lookup-result">
      <div className="flex items-center gap-3">
        {result.avatar
          ? <img src={result.avatar} alt="WhatsApp profile picture" className="h-16 w-16 rounded-full object-cover" />
          : <span className={cn('flex h-16 w-16 items-center justify-center rounded-full', problem ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500 dark:bg-slate-800')}>{problem ? <AlertTriangle className="h-6 w-6" /> : <UserRound className="h-6 w-6" />}</span>}
        <div className="min-w-0">
          {result.status === 'on_whatsapp' && <p className="truncate text-base font-semibold">{result.pushName ?? 'On WhatsApp (no name set)'}</p>}
          {result.number && <p className="text-sm text-muted">+{result.number}</p>}
          <p className={cn('text-sm', problem && 'font-medium text-amber-800 dark:text-amber-300')}>
            {result.message}{result.fromCache ? ' (remembered from a moment ago)' : ''}
          </p>
          {result.status === 'on_whatsapp' && !result.avatar && <p className="text-xs text-muted">No profile picture is shown (none set, or hidden).</p>}
        </div>
      </div>

      {result.status === 'on_whatsapp' && (
        result.matches.length === 0
          ? <p className="border-t border-[var(--border)] pt-3 text-sm text-muted">This number is not on any contact you can open.</p>
          : (
            <div className="space-y-2 border-t border-[var(--border)] pt-3">
              <p className="text-sm font-medium">{result.matches.length === 1 ? 'This number belongs to' : `${result.matches.length} contacts share this number — choose one`}</p>
              {result.matches.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60">
                  <Link to={`/${m.module}/${m.id}`} className="text-sm font-medium text-brand-700 hover:underline">{m.name}</Link>
                  {saved[m.id]
                    ? <span className="text-xs font-medium text-positive">{saved[m.id]}</span>
                    : <button className="btn-secondary btn-sm" disabled={saving || (!result.avatar && !result.pushName)} onClick={() => onSave(m.id)}>Save avatar (and WhatsApp name) to this record</button>}
                </div>
              ))}
            </div>
          )
      )}
    </div>
  );
}
