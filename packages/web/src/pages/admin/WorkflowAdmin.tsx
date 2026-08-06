import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import {
  Clock, PlayCircle, Plus, Timer, Trash2, Workflow, Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, ConfirmDialog, EmptyState, Modal, Select, Skeleton, Spinner, Tabs, Toggle } from '../../components/ui';

interface WorkflowRow {
  id: string; module: string; name: string; description: string | null;
  trigger: string; is_active: boolean; is_system: boolean;
  last_run_at: string | null; next_run_at: string | null;
  run_count: number; task_count: number;
}

const TRIGGER_LABELS: Record<string, string> = {
  on_create: 'When created',
  on_modify: 'When modified',
  on_create_or_modify: 'When created or modified',
  on_field_change: 'When a field changes',
  on_delete: 'When deleted',
  scheduled: 'On a schedule',
  manual: 'Manually',
  on_inbound_message: 'On inbound message',
  on_call_end: 'When a call ends',
};

export default function WorkflowAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('workflows');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkflowRow | null>(null);
  const [running, setRunning] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['workflows'], queryFn: () => api.workflows() });
  const { data: queue } = useQuery({
    queryKey: ['task-queue'],
    queryFn: () => api.taskQueue(),
    enabled: tab === 'queue',
  });
  const { data: rules } = useQuery({
    queryKey: ['assignment-rules'],
    queryFn: () => api.assignmentRules(),
    enabled: tab === 'assignment',
  });

  const workflows = (data?.workflows ?? []) as unknown as WorkflowRow[];
  const byModule = workflows.reduce<Record<string, WorkflowRow[]>>((acc, w) => {
    (acc[w.module] ??= []).push(w);
    return acc;
  }, {});

  const toggleActive = async (w: WorkflowRow): Promise<void> => {
    try {
      await api.updateWorkflow(w.id, { isActive: !w.is_active });
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    } catch (err) {
      toast.error('Could not update', (err as Error).message);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Workflows</h1>
          <p className="text-sm text-slate-500">
            Automation that runs when records change or on a schedule. Everything shipped with iPropy
            is an ordinary workflow you can edit or switch off.
          </p>
        </div>
        <button
          onClick={async () => {
            setRunning(true);
            try {
              await api.runScheduler();
              toast.success('Scheduler run triggered');
              void queryClient.invalidateQueries({ queryKey: ['task-queue'] });
            } catch (err) {
              toast.error('Failed', (err as Error).message);
            } finally {
              setRunning(false);
            }
          }}
          disabled={running}
          className="btn-secondary btn-sm ml-auto"
        >
          {running ? <Spinner className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
          Run scheduler now
        </button>
      </div>

      <Tabs
        tabs={[
          { key: 'workflows', label: 'Workflows', icon: <Workflow className="h-3.5 w-3.5" />, count: workflows.length },
          { key: 'assignment', label: 'Assignment rules', icon: <Zap className="h-3.5 w-3.5" /> },
          { key: 'queue', label: 'Task queue', icon: <Timer className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'workflows' && (
        isLoading ? (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : (
          <div className="space-y-4">
            {Object.entries(byModule).map(([moduleName, list]) => (
              <div key={moduleName} className="card overflow-hidden">
                <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/40">
                  <p className="text-2xs font-semibold uppercase tracking-wide text-slate-500">
                    {moduleName.replace(/_/g, ' ')}
                  </p>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {list.map((w) => (
                    <li key={w.id} className="flex items-start gap-3 p-3">
                      <button
                        onClick={() => setDetailId(w.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={cn('text-sm font-medium', !w.is_active && 'text-slate-400 line-through')}>
                            {w.name}
                          </span>
                          <Badge color={w.trigger === 'scheduled' ? '#a855f7' : '#0ea5e9'}>
                            {TRIGGER_LABELS[w.trigger] ?? w.trigger}
                          </Badge>
                          <Badge>{w.task_count} task{w.task_count === 1 ? '' : 's'}</Badge>
                          {w.is_system && <Badge color="#94a3b8">Built-in</Badge>}
                        </div>
                        {w.description && (
                          <p className="mt-0.5 text-xs text-slate-500">{w.description}</p>
                        )}
                        <p className="mt-1 text-2xs text-slate-400 tnum">
                          {w.run_count > 0 ? `Ran ${w.run_count} times` : 'Never run'}
                          {w.last_run_at && ` · last ${relativeTime(w.last_run_at)}`}
                          {w.next_run_at && ` · next ${relativeTime(w.next_run_at)}`}
                        </p>
                      </button>

                      <div className="flex shrink-0 items-center gap-2">
                        <Toggle checked={w.is_active} onChange={() => void toggleActive(w)} />
                        {!w.is_system && (
                          <button
                            onClick={() => setDeleting(w)}
                            className="text-slate-300 hover:text-red-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'assignment' && (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Lead assignment rules</p>
            <p className="text-xs text-slate-500">
              Evaluated in order — the first matching rule assigns the record.
            </p>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {((rules ?? []) as { id: string; name: string; strategy: string; module: string; group_name: string | null; is_active: boolean; sequence: number }[])
              .map((r, i) => (
                <li key={r.id} className="flex items-center gap-3 p-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-2xs font-semibold text-slate-500 dark:bg-slate-800">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="text-2xs text-slate-500">
                      {r.strategy.replace(/_/g, ' ')}
                      {r.group_name && ` → ${r.group_name}`}
                    </p>
                  </div>
                  <Badge color={r.is_active ? '#22c55e' : '#94a3b8'}>
                    {r.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </li>
              ))}
            {(!rules || rules.length === 0) && (
              <EmptyState title="No assignment rules" body="Inbound leads stay unassigned until a rule matches." />
            )}
          </ul>
        </div>
      )}

      {tab === 'queue' && (
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Deferred tasks</p>
            <p className="text-xs text-slate-500">
              Delayed workflow actions — reminders, follow-ups, scheduled messages.
            </p>
          </div>
          {!queue?.length ? (
            <EmptyState icon={<Clock className="h-8 w-8" />} title="Queue is empty" />
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  {['Task', 'Record', 'Run at', 'Status', 'Attempts'].map((h) => (
                    <th key={h} className="table-head">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(queue as { id: string; task_name: string; task_type: string; workflow_name: string; record_label: string; run_at: string; status: string; attempts: number; last_error: string | null }[])
                  .map((job) => (
                    <tr key={job.id}>
                      <td className="table-cell">
                        <p className="font-medium">{job.task_name}</p>
                        <p className="text-2xs text-slate-500">{job.workflow_name}</p>
                      </td>
                      <td className="table-cell text-slate-600 dark:text-slate-400">{job.record_label ?? '—'}</td>
                      <td className="table-cell text-2xs tnum text-slate-500">{relativeTime(job.run_at)}</td>
                      <td className="table-cell">
                        <Badge color={
                          job.status === 'done' ? '#22c55e'
                            : job.status === 'failed' ? '#ef4444'
                            : job.status === 'running' ? '#0ea5e9' : '#94a3b8'
                        }>
                          {job.status}
                        </Badge>
                        {job.last_error && (
                          <p className="mt-0.5 max-w-xs truncate text-2xs text-red-500" title={job.last_error}>
                            {job.last_error}
                          </p>
                        )}
                      </td>
                      <td className="table-cell tnum text-slate-500">{job.attempts}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {detailId && <WorkflowDetail id={detailId} onClose={() => setDetailId(null)} />}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          await api.deleteWorkflow(deleting!.id);
          toast.success('Workflow deleted');
          void queryClient.invalidateQueries({ queryKey: ['workflows'] });
        }}
        title={`Delete “${deleting?.name}”?`}
        body="This cannot be undone."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function WorkflowDetail({ id, onClose }: { id: string; onClose: () => void }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['workflow', id],
    queryFn: () => api.workflow(id),
  });

  const wf = data as {
    name: string; description: string | null; trigger: string; module: string;
    conditions: { logic: string; conditions: unknown[] };
    tasks: { id: string; type: string; name: string; delay_minutes: number; delay_field: string | null; delay_direction: string | null; config: Record<string, unknown> }[];
    recentRuns: { id: string; status: string; matched: boolean; tasks_run: number; duration_ms: number; error: string | null; created_at: string }[];
  } | undefined;

  return (
    <Modal open onClose={onClose} title={wf?.name ?? 'Workflow'} size="lg">
      {isLoading || !wf ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : (
        <div className="space-y-4">
          {wf.description && <p className="text-sm text-slate-600 dark:text-slate-400">{wf.description}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-2xs uppercase tracking-wide text-slate-400">Trigger</p>
              <p className="mt-0.5 text-sm font-medium">{TRIGGER_LABELS[wf.trigger] ?? wf.trigger}</p>
              <p className="text-2xs text-slate-500">on {wf.module.replace(/_/g, ' ')}</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-2xs uppercase tracking-wide text-slate-400">Conditions</p>
              <p className="mt-0.5 text-sm font-medium tnum">
                {wf.conditions?.conditions?.length
                  ? `${wf.conditions.conditions.length} condition${wf.conditions.conditions.length === 1 ? '' : 's'} (${wf.conditions.logic})`
                  : 'Always runs'}
              </p>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Actions</p>
            <ol className="space-y-2">
              {wf.tasks.map((task, i) => (
                <li key={task.id} className="flex gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-2xs font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{task.name}</span>
                      <Badge>{task.type.replace(/_/g, ' ')}</Badge>
                      {(task.delay_minutes > 0 || task.delay_field) && (
                        <Badge color="#f59e0b">
                          <Clock className="h-2.5 w-2.5" />
                          {task.delay_field
                            ? `${task.delay_minutes}m ${task.delay_direction} ${task.delay_field}`
                            : `after ${task.delay_minutes}m`}
                        </Badge>
                      )}
                    </div>
                    {Object.keys(task.config).length > 0 && (
                      <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-slate-50 p-2 text-2xs text-slate-500 dark:bg-slate-800">
                        {JSON.stringify(task.config, null, 2)}
                      </pre>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {wf.recentRuns.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium">Recent runs</p>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {wf.recentRuns.map((run) => (
                  <li key={run.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50 dark:hover:bg-slate-800">
                    <Badge color={run.status === 'success' ? '#22c55e' : '#ef4444'}>{run.status}</Badge>
                    <span className="text-slate-500 tnum">{run.tasks_run} tasks · {run.duration_ms}ms</span>
                    <span className="ml-auto text-slate-400">{relativeTime(run.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
