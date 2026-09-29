import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { Avatar } from './ui';

/**
 * "Whose records?" — one row of agent chips, used by both the Status and the
 * Task panels on the list toolbar.
 *
 * One component and one piece of state behind it (the list's own agent
 * choice), so picking Vijay in either panel narrows the list, the stage counts
 * and the task counts together. Two copies would drift, and the way they drift
 * is that one panel says Vijay while the list shows everybody.
 */
export function AgentPicker({ agent, onPickAgent }: {
  agent: string | null;
  onPickAgent: (userId: string | null) => void;
}): JSX.Element | null {
  const { data: rawUsers } = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.users(false, false, true),
  });
  // `api.users` is untyped on purpose (the admin screens read many shapes off
  // it); narrow to the two fields this needs rather than casting inline.
  const users = (rawUsers ?? []).map((u) => ({
    id: String((u as { id?: unknown }).id ?? ''),
    name: String((u as { fullName?: unknown }).fullName ?? ''),
  })).filter((u) => u.id && u.name);

  // One person is not a choice.
  if (users.length <= 1) return null;
  return (
    <div className="border-b border-slate-100 px-1 pb-2 pt-0.5 dark:border-slate-800">
      <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span>Filter by agent</span>
        <button
          type="button"
          onClick={() => onPickAgent(null)}
          className={cn(
            'font-medium normal-case',
            agent === null ? 'text-muted' : 'text-brand-600 hover:underline dark:text-brand-400',
          )}
        >
          All
        </button>
      </div>
      {/* Two rows of agents, then it scrolls — every agent is reachable, but
          nine people as three rows of chips pushed the list below off screen. */}
      <div className="grid max-h-[3.4rem] grid-cols-3 gap-1 overflow-y-auto">
        {users.map((user) => {
          const mine = agent === user.id;
          return (
            <button
              key={user.id}
              type="button"
              aria-pressed={mine}
              title={user.name}
              onClick={() => onPickAgent(mine ? null : user.id)}
              className={cn(
                'flex items-center justify-center gap-1 truncate rounded-md border px-1.5 py-1 text-[10px] transition-colors',
                mine
                  ? 'border-brand-200 bg-brand-50 font-semibold text-brand-700 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-200'
                  : 'border-slate-200 bg-slate-50 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-800',
              )}
            >
              <Avatar name={user.name} size={14} className="text-[8px]" />
              <span className="truncate">{user.name.split(/\s+/)[0]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
