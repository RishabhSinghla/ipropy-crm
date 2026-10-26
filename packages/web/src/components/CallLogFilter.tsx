import type { JSX } from 'react';
import { Check, PhoneCall } from 'lucide-react';
import type { ListQuery } from '@ipropy/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCallDispositionOptions } from '../lib/callDispositions';
import { cn } from '../lib/utils';
import { toolbarButton, toolbarCount } from '../lib/toolbarButton';
import { Dropdown } from './ui';
import { AgentPicker } from './AgentPicker';
import { dispositionIsOn, LAST_CALL_DISPOSITION, type DispositionPick } from './CallDispositionFilter';

/** Agent and call outcome filters, available directly from the list ribbon. */
export function CallLogFilter({
  module, view, search, filter, agent, onAgent, disposition, onDisposition, count,
}: {
  module: string;
  view?: string;
  search?: string;
  filter?: ListQuery['filter'];
  agent: string | null;
  onAgent: (id: string | null) => void;
  disposition: DispositionPick;
  onDisposition: (pick: DispositionPick) => void;
  count: number;
}): JSX.Element {
  const options = useCallDispositionOptions();
  const users = useQuery({
    queryKey: ['users', 'filter-agents', module],
    queryFn: () => api.users(false, false, true, module),
  });
  const agentName = (users.data ?? []).find((item) => String((item as { id?: unknown }).id ?? '') === agent);
  const agentLabel = agentName ? String((agentName as { fullName?: unknown }).fullName ?? '') : '';
  const facet = useQuery({
    queryKey: ['call-log-ribbon-facet', module, view, search, filter],
    queryFn: () => api.facet(module, LAST_CALL_DISPOSITION, undefined, 50, { view, search, filter }),
  });
  const byValue = new Map((facet.data?.values ?? []).map((item) => [item.value, item.count]));
  const active = dispositionIsOn(disposition) || agent !== null;
  const selectedText = disposition.never
    ? 'Never called'
    : disposition.outcomes.length === 1
      ? options.find((item) => item.value === disposition.outcomes[0])?.label ?? 'Call Log'
      : disposition.outcomes.length > 1
        ? `${disposition.outcomes.length} outcomes`
        : agent ? (agentLabel || 'Agent selected') : 'Call Log';
  const total = facet.data
    ? facet.data.values.reduce((sum, item) => sum + item.count, 0) + facet.data.blank
    : count;

  return (
    <Dropdown align="right" className="w-72" trigger={(
      <button type="button" className={toolbarButton(active, 'h-6 px-2 text-[10px]')} aria-label="Call Log filter" aria-pressed={active} data-testid="call-log-filter">
        <PhoneCall className="h-3 w-3" aria-hidden="true" />
        <span className="max-w-24 truncate">{selectedText}</span>
        <span className={toolbarCount(active)}>{active ? count : total}</span>
      </button>
    )}>
      {(close) => (
        <div className="max-h-[min(70vh,28rem)] overflow-y-auto p-2 text-xs" aria-label="Call Log filters">
          <AgentPicker moduleName={module} agent={agent} onPickAgent={onAgent} />
          <div className="flex items-center justify-between px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
            <span>Call disposition</span>
            {(dispositionIsOn(disposition) || agent) && <button type="button" className="normal-case text-brand-700 hover:underline" onClick={() => { onDisposition({ outcomes: [], never: false }); onAgent(null); }}>Clear all</button>}
          </div>
          <button type="button" aria-pressed={!dispositionIsOn(disposition)} onClick={() => { onDisposition({ outcomes: [], never: false }); close(); }} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800', !dispositionIsOn(disposition) && 'font-semibold text-brand-700 dark:text-brand-300')}>
            <span>All call logs</span><span className="flex items-center gap-2 text-muted">{total.toLocaleString('en-IN')}{!dispositionIsOn(disposition) && <Check className="h-3 w-3" />}</span>
          </button>
          <button type="button" aria-pressed={disposition.never} onClick={() => onDisposition({ outcomes: [], never: !disposition.never })} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800', disposition.never && 'font-semibold text-brand-700 dark:text-brand-300')}>
            <span>Never called</span><span className="flex items-center gap-2 text-muted">{(facet.data?.blank ?? 0).toLocaleString('en-IN')}{disposition.never && <Check className="h-3 w-3" />}</span>
          </button>
          {options.map((option) => {
            const selected = disposition.outcomes.includes(option.value);
            return <button key={option.value} type="button" aria-pressed={selected} onClick={() => onDisposition({ outcomes: selected ? disposition.outcomes.filter(value => value !== option.value) : [...disposition.outcomes, option.value], never: false })} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800', selected && 'font-semibold text-brand-700 dark:text-brand-300')}>
              <span className="truncate">{option.label}</span><span className="flex items-center gap-2 text-muted">{(byValue.get(option.value) ?? 0).toLocaleString('en-IN')}{selected && <Check className="h-3 w-3" />}</span>
            </button>;
          })}
        </div>
      )}
    </Dropdown>
  );
}
