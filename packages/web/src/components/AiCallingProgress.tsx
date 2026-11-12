import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

/**
 * Today's progress for the AI agent's automatic calling, and the last seven days.
 *
 * "Planned" is how many the morning run queued; "done" is calls the agent actually made today. A queue that is
 * still working shows done below planned; one that was stopped at the end of calling hours stays below it, and the
 * runs list on Admin → AI calling says why.
 */
const MODULE_LABEL: Record<string, string> = { leads: 'Contacts (Buyer agent)', properties: 'Inventories (Seller agent)' };

export function AiCallingProgress({ compact = false }: { compact?: boolean }): JSX.Element | null {
  const { data, error } = useQuery({ queryKey: ['ai-calling-status'], queryFn: () => api.aiCallingStatus(), refetchInterval: 30_000, retry: false });
  // Someone who may not place calls simply sees nothing here.
  if (error || !data) return null;
  const today = data.perDay.filter((row) => row.day === data.today);
  const sum = (rows: typeof today, key: 'calls' | 'answered' | 'interested' | 'failed'): number => rows.reduce((n, r) => n + r[key], 0);
  const days = [...new Set(data.perDay.map((r) => r.day))].sort().reverse().slice(0, 7);

  return (
    <section className="card space-y-3 p-4" data-testid="ai-calling-progress" aria-label="AI calling progress">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-4 w-4 text-brand-600" aria-hidden />
        <h2 className="text-sm font-semibold">AI calling today</h2>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', data.masterEnabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600')}>
          {data.masterEnabled ? 'Automatic calling is ON' : 'Automatic calling is OFF'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="Planned" value={Object.values(data.planned).reduce((a, b) => a + b, 0)} />
        <Tile label="Called" value={sum(today, 'calls')} />
        <Tile label="Spoke to" value={sum(today, 'answered')} />
        <Tile label="Interested" value={sum(today, 'interested')} />
        <Tile label="No answer / failed" value={sum(today, 'failed')} />
      </div>
      {!compact && (
        <>
          {Object.entries(data.blocked).filter(([, why]) => why).map(([module, why]) => (
            <p key={module} className="text-xs text-muted"><strong>{MODULE_LABEL[module] ?? module}:</strong> {why}</p>
          ))}
          {days.length > 0 && (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted"><th className="py-1">Last 7 days</th><th>Called</th><th>Spoke to</th><th>Interested</th><th>No answer / failed</th></tr></thead>
              <tbody>
                {days.map((day) => {
                  const rows = data.perDay.filter((r) => r.day === day);
                  return <tr key={day} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">{day}</td><td>{sum(rows, 'calls')}</td><td>{sum(rows, 'answered')}</td><td>{sum(rows, 'interested')}</td><td>{sum(rows, 'failed')}</td></tr>;
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: number }): JSX.Element {
  return <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50"><div className="text-lg font-semibold tabular-nums">{value}</div><div className="text-[11px] text-muted">{label}</div></div>;
}
