/**
 * "Is the AI caller properly connected?", answered with facts: each line is one thing the CRM checked, and the
 * button beside it asks Sarvam what happened to every recent call and makes this list agree.
 */
import { type JSX, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';

const ICON = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle } as const;
const TONE = { ok: 'text-positive', warn: 'text-amber-600 dark:text-amber-400', fail: 'text-negative' } as const;

export default function SarvamHealth(): JSX.Element {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const health = useQuery({ queryKey: ['sarvam-health'], queryFn: api.sarvamHealth, staleTime: 30_000, retry: false });

  const sync = async (): Promise<void> => {
    setSyncing(true);
    try {
      const report = await api.sarvamReconcile(72);
      (report.ok ? toast.success : toast.error)(report.ok ? 'Agreed with Sarvam' : 'Sync stopped', report.message);
      await queryClient.invalidateQueries({ queryKey: ['sarvam-health'] });
      await queryClient.invalidateQueries({ queryKey: ['sarvam-control'] });
    } catch (err) {
      toast.error('Could not sync with Sarvam', (err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mx-4 mb-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs dark:border-slate-700 dark:bg-slate-800/30" data-testid="sarvam-health">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 font-medium">Is it properly connected?</p>
        <button type="button" className="btn-secondary btn-sm" disabled={health.isFetching} onClick={() => void health.refetch()}>
          {health.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Check everything
        </button>
        <button type="button" className="btn-secondary btn-sm" disabled={syncing} onClick={() => void sync()}>
          {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Sync from Sarvam
        </button>
      </div>
      {health.error && <p className="mt-2 text-negative">Could not run the checks: {(health.error as Error).message}</p>}
      {health.data && (
        <ul className="mt-2 space-y-1.5">
          {health.data.checks.map((check) => {
            const Icon = ICON[check.status];
            return (
              <li key={check.label} className="flex items-start gap-1.5">
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONE[check.status]}`} aria-label={check.status} />
                <span><strong>{check.label}.</strong> <span className="text-muted">{check.detail}</span></span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
