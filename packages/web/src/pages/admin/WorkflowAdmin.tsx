import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FilterGroup, type ModuleMeta, relativeTime } from '@ipropy/shared';
import {
  Clock, Edit3, GripVertical, PlayCircle, Plus, Timer, Trash2, Workflow, X, Zap,
} from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, ConfirmDialog, EmptyState, Modal, Select, Skeleton, Spinner, Tabs, Toggle } from '../../components/ui';
import { FilterBuilder } from '../../components/FilterBuilder';

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

  const [composing, setComposing] = useState<{ id?: string } | null>(null);
  const { modules } = useApp();

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
          <p className="text-sm text-muted">
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
        <button onClick={() => setComposing({})} className="btn-primary btn-sm">
          <Plus className="h-3.5 w-3.5" /> New workflow
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
                  <p className="text-2xs font-semibold uppercase tracking-wide text-muted">
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
                          <p className="mt-0.5 text-xs text-muted">{w.description}</p>
                        )}
                        <p className="mt-1 text-2xs text-muted tnum">
                          {w.run_count > 0 ? `Ran ${w.run_count} times` : 'Never run'}
                          {w.last_run_at && ` · last ${relativeTime(w.last_run_at)}`}
                          {w.next_run_at && ` · next ${relativeTime(w.next_run_at)}`}
                        </p>
                      </button>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => setComposing({ id: w.id })}
                          className="text-slate-300 hover:text-brand-600"
                          title="Edit"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
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
            <p className="text-xs text-muted">
              Evaluated in order — the first matching rule assigns the record.
            </p>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {((rules ?? []) as { id: string; name: string; strategy: string; module: string; group_name: string | null; is_active: boolean; sequence: number }[])
              .map((r, i) => (
                <li key={r.id} className="flex items-center gap-3 p-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-2xs font-semibold text-muted dark:bg-slate-800">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="text-2xs text-muted">
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
            <p className="text-xs text-muted">
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
                    <th key={h} className="list-head">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {(queue as { id: string; task_name: string; task_type: string; workflow_name: string; record_label: string; run_at: string; status: string; attempts: number; last_error: string | null }[])
                  .map((job) => (
                    <tr key={job.id}>
                      <td className="list-cell">
                        <p className="font-medium">{job.task_name}</p>
                        <p className="text-2xs text-muted">{job.workflow_name}</p>
                      </td>
                      <td className="list-cell text-slate-600 dark:text-slate-400">{job.record_label ?? '—'}</td>
                      <td className="list-cell text-2xs tnum text-muted">{relativeTime(job.run_at)}</td>
                      <td className="list-cell">
                        <Badge color={
                          job.status === 'done' ? '#22c55e'
                            : job.status === 'failed' ? '#ef4444'
                            : job.status === 'running' ? '#0ea5e9' : '#94a3b8'
                        }>
                          {job.status}
                        </Badge>
                        {job.last_error && (
                          <p className="mt-0.5 max-w-xs truncate text-2xs text-negative" title={job.last_error}>
                            {job.last_error}
                          </p>
                        )}
                      </td>
                      <td className="list-cell tnum text-slate-500">{job.attempts}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {detailId && <WorkflowDetail id={detailId} onClose={() => setDetailId(null)} />}

      {composing && (
        <WorkflowComposer
          workflowId={composing.id}
          modules={modules.filter((m) => m.isEntity)}
          onClose={() => setComposing(null)}
          onSaved={() => {
            setComposing(null);
            void queryClient.invalidateQueries({ queryKey: ['workflows'] });
          }}
        />
      )}

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
          {wf.description && <p className="text-sm text-muted">{wf.description}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-2xs uppercase tracking-wide text-muted">Trigger</p>
              <p className="mt-0.5 text-sm font-medium">{TRIGGER_LABELS[wf.trigger] ?? wf.trigger}</p>
              <p className="text-2xs text-muted">on {wf.module.replace(/_/g, ' ')}</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-2xs uppercase tracking-wide text-muted">Conditions</p>
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
                      <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-slate-50 p-2 text-2xs text-muted dark:bg-slate-800">
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
                    {/* 'partial' is its own colour on purpose: some tasks ran and
                        some threw. Green would hide the failure, red would imply
                        nothing happened — and something did, irreversibly.
                        amber-700 (#b45309), not amber-500, for the same contrast
                        reason as the queue badge in Layout.tsx. */}
                    <Badge color={run.status === 'success' ? '#22c55e' : run.status === 'partial' ? '#b45309' : '#ef4444'}>{run.status}</Badge>
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

// ---------------------------------------------------------------------------
// Composer — create or edit a workflow: trigger, conditions, ordered tasks.
// ---------------------------------------------------------------------------

const TASK_TYPE_LABELS: Record<string, string> = {
  update_fields: 'Update fields',
  create_record: 'Create a related record',
  create_task: 'Create a task',
  create_event: 'Create an event',
  assign_owner: 'Assign an owner',
  notify_user: 'Notify a user',
  send_whatsapp: 'Send WhatsApp message',
  send_email: 'Send email',
  send_sms: 'Send SMS',
  webhook: 'Call a webhook',
  add_tag: 'Add tags',
  ai_action: 'Run an AI action',
  trigger_call: 'Trigger a call',
  delay: 'Wait',
};

/**
 * The AI actions the workflow engine actually implements — the switch in
 * `server/src/ai/actions.ts`. Anything not on this list falls through to its
 * default case, which logs and does nothing.
 */
const AI_ACTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'score_lead', label: 'Score the lead', hint: 'Writes an AI score and the reasons behind it.' },
  { value: 'match_properties', label: 'Match properties to this buyer', hint: 'Ranks available inventory against the requirement and tells the owner.' },
  { value: 'match_buyers', label: 'Match buyers to this unit', hint: 'Tells each rep which of their buyers were waiting for this unit. Only alerts a buyer once per unit.' },
  { value: 'draft_message', label: 'Draft a message', hint: 'Writes a WhatsApp, email or SMS draft a following send step can use.' },
  { value: 'summarise_record', label: 'Summarise the record', hint: 'Writes a short summary into the insights panel, and optionally a field.' },
  { value: 'summarise_visit', label: 'Summarise a site visit', hint: 'Turns the visit feedback and objections into a summary and a sentiment.' },
  { value: 'classify', label: 'Classify', hint: 'Answers a question you set with one of the options you list, and writes it to a field.' },
];

interface TaskDraft {
  key: string;
  type: string;
  name: string;
  delayMode: 'none' | 'after' | 'field';
  delayMinutes: number;
  delayField: string;
  delayDirection: 'before' | 'after';
  config: Record<string, unknown>;
}

function newTask(type: string): TaskDraft {
  return {
    key: Math.random().toString(36).slice(2),
    type, name: TASK_TYPE_LABELS[type] ?? type,
    delayMode: 'none', delayMinutes: 0, delayField: '', delayDirection: 'after',
    config: {},
  };
}

function RecipientPicker({
  value, onChange, users,
}: { value: string; onChange: (v: string) => void; users: { id: string; fullName: string }[] }): JSX.Element {
  const preset = value === 'record_owner' || value === 'owner_manager' || value.startsWith('user:') ? value.startsWith('user:') ? 'user' : value : 'custom';
  return (
    <div className="flex gap-2">
      <Select
        value={preset}
        onChange={(v) => {
          if (v === 'user') onChange(`user:${users[0]?.id ?? ''}`);
          else if (v === 'custom') onChange('');
          else onChange(v);
        }}
        className="w-44 shrink-0"
        options={[
          { value: 'record_owner', label: "Record's owner" },
          { value: 'owner_manager', label: "Owner's manager" },
          { value: 'user', label: 'Specific user' },
          { value: 'custom', label: 'Custom (group:/role:)' },
        ]}
      />
      {preset === 'user' ? (
        <Select
          value={value.replace('user:', '')}
          onChange={(v) => onChange(`user:${v}`)}
          className="flex-1"
          options={users.map((u) => ({ value: u.id, label: u.fullName }))}
        />
      ) : preset === 'custom' ? (
        <input
          className="input flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="group:Sales or role:Sales Manager"
        />
      ) : null}
    </div>
  );
}

function TaskConfigFields({
  task, onChange, module, users,
}: {
  task: TaskDraft;
  onChange: (config: Record<string, unknown>) => void;
  module: ModuleMeta | undefined;
  users: { id: string; fullName: string }[];
}): JSX.Element {
  const set = (patch: Record<string, unknown>): void => onChange({ ...task.config, ...patch });
  const writable = module?.fields.filter((f) => f.isActive && !f.isReadonly) ?? [];

  switch (task.type) {
    case 'update_fields': {
      const values = (task.config.values as Record<string, string>) ?? {};
      const rows = Object.entries(values);
      return (
        <div className="space-y-2">
          <label className="label">Field updates</label>
          {rows.map(([field, val], i) => (
            <div key={i} className="flex gap-2">
              <Select
                value={field}
                onChange={(next) => {
                  const entries = Object.entries(values);
                  entries[i] = [next, val];
                  set({ values: Object.fromEntries(entries) });
                }}
                className="w-48 shrink-0"
                options={writable.map((f) => ({ value: f.name, label: f.label }))}
              />
              <input
                className="input flex-1"
                value={val}
                onChange={(e) => {
                  const entries = Object.entries(values);
                  entries[i] = [field, e.target.value];
                  set({ values: Object.fromEntries(entries) });
                }}
                placeholder="Literal value or {{merge_field}}"
              />
              <button
                onClick={() => {
                  const entries = Object.entries(values).filter((_, idx) => idx !== i);
                  set({ values: Object.fromEntries(entries) });
                }}
                className="btn-ghost p-1.5 text-slate-400 hover:text-red-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            onClick={() => set({ values: { ...values, [writable[0]?.name ?? '']: '' } })}
            className="btn-secondary btn-sm"
            disabled={!writable.length}
          >
            <Plus className="h-3 w-3" /> Add field update
          </button>
        </div>
      );
    }

    case 'create_record': {
      const values = (task.config.values as Record<string, string>) ?? {};
      const rows = Object.entries(values);
      return (
        <div className="space-y-2">
          <label className="label">Create a record in</label>
          <input
            className="input"
            value={(task.config.module as string) ?? ''}
            onChange={(e) => set({ module: e.target.value })}
            placeholder="module API name, e.g. leads"
          />
          <label className="label mt-2">Field values</label>
          {rows.map(([field, val], i) => (
            <div key={i} className="flex gap-2">
              <input
                className="input w-48 shrink-0 font-mono text-xs"
                value={field}
                onChange={(e) => {
                  const entries = Object.entries(values);
                  entries[i] = [e.target.value, val];
                  set({ values: Object.fromEntries(entries) });
                }}
                placeholder="field_name"
              />
              <input
                className="input flex-1"
                value={val}
                onChange={(e) => {
                  const entries = Object.entries(values);
                  entries[i] = [field, e.target.value];
                  set({ values: Object.fromEntries(entries) });
                }}
                placeholder="Literal value or {{merge_field}}"
              />
              <button
                onClick={() => set({ values: Object.fromEntries(Object.entries(values).filter((_, idx) => idx !== i)) })}
                className="btn-ghost p-1.5 text-slate-400 hover:text-red-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button onClick={() => set({ values: { ...values, '': '' } })} className="btn-secondary btn-sm">
            <Plus className="h-3 w-3" /> Add field value
          </button>
          <label className="label mt-2">Link back via field (optional)</label>
          <input
            className="input"
            value={(task.config.linkField as string) ?? ''}
            onChange={(e) => set({ linkField: e.target.value || undefined })}
            placeholder="e.g. deal_id — set to this record's id on the new record"
          />
        </div>
      );
    }

    case 'create_task':
    case 'create_event':
      return (
        <div className="space-y-2">
          <label className="label">Subject</label>
          <input className="input" value={(task.config.subject as string) ?? ''} onChange={(e) => set({ subject: e.target.value })} placeholder="Follow up with {{first_name}}" />
          <label className="label mt-2">Description</label>
          <textarea className="input" rows={2} value={(task.config.description as string) ?? ''} onChange={(e) => set({ description: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Due in (minutes)</label>
              <input type="number" className="input" value={Number(task.config.dueInMinutes ?? 60)} onChange={(e) => set({ dueInMinutes: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label">Priority</label>
              <Select
                value={(task.config.priority as string) ?? 'Medium'}
                onChange={(v) => set({ priority: v })}
                options={['Low', 'Medium', 'High'].map((p) => ({ value: p, label: p }))}
              />
            </div>
          </div>
          <label className="label mt-2">Assign to</label>
          <RecipientPicker value={(task.config.assignTo as string) ?? 'record_owner'} onChange={(v) => set({ assignTo: v })} users={users} />
        </div>
      );

    case 'assign_owner': {
      const strategy = (task.config.strategy as string) ?? 'rules';
      return (
        <div className="space-y-2">
          <label className="label">Strategy</label>
          <Select
            value={strategy}
            onChange={(v) => set({ strategy: v })}
            options={[
              { value: 'rules', label: 'Use assignment rules' },
              { value: 'round_robin', label: 'Round robin' },
              { value: 'load_balanced', label: 'Load balanced (fewest open records)' },
              { value: 'least_busy', label: 'Least busy (fewest open tasks today)' },
              { value: 'specific_user', label: 'Specific user' },
            ]}
          />
          {strategy !== 'rules' && (
            <>
              <label className="label mt-2">Candidate users</label>
              <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                {users.map((u) => {
                  const ids = (task.config.userIds as string[]) ?? [];
                  const active = ids.includes(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => set({ userIds: active ? ids.filter((id) => id !== u.id) : [...ids, u.id] })}
                      className={cn(
                        'rounded px-2 py-1 text-xs transition-colors',
                        active ? 'bg-brand-100 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                      )}
                    >
                      {u.fullName}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      );
    }

    case 'notify_user':
      return (
        <div className="space-y-2">
          <label className="label">Notify</label>
          <RecipientPicker value={(task.config.to as string) ?? 'record_owner'} onChange={(v) => set({ to: v })} users={users} />
          <label className="label mt-2">Title</label>
          <input className="input" value={(task.config.title as string) ?? ''} onChange={(e) => set({ title: e.target.value })} />
          <label className="label mt-2">Body</label>
          <textarea className="input" rows={2} value={(task.config.body as string) ?? ''} onChange={(e) => set({ body: e.target.value })} placeholder="Supports {{merge_field}}" />
        </div>
      );

    case 'send_whatsapp':
      return (
        <div className="space-y-2">
          <label className="label">To</label>
          <input className="input" value={(task.config.to as string) ?? '{{mobile}}'} onChange={(e) => set({ to: e.target.value })} />
          <label className="label mt-2">Approved template name (optional)</label>
          <input className="input" value={(task.config.template as string) ?? ''} onChange={(e) => set({ template: e.target.value || undefined })} />
          <label className="label mt-2">Fallback text (used outside the 24h window with no template)</label>
          <textarea className="input" rows={2} value={(task.config.fallbackText as string) ?? ''} onChange={(e) => set({ fallbackText: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={Boolean(task.config.useAiDraft)} onChange={(e) => set({ useAiDraft: e.target.checked })} />
            Let AI draft the message from the record's context
          </label>
        </div>
      );

    case 'send_email':
      return (
        <div className="space-y-2">
          <label className="label">To</label>
          <input className="input" value={(task.config.to as string) ?? '{{email}}'} onChange={(e) => set({ to: e.target.value })} />
          <label className="label mt-2">Template name (optional — otherwise uses subject/body below)</label>
          <input className="input" value={(task.config.template as string) ?? ''} onChange={(e) => set({ template: e.target.value || undefined })} />
          <label className="label mt-2">Subject</label>
          <input className="input" value={(task.config.subject as string) ?? ''} onChange={(e) => set({ subject: e.target.value })} />
          <label className="label mt-2">Body (HTML)</label>
          <textarea className="input font-mono text-xs" rows={3} value={(task.config.html as string) ?? ''} onChange={(e) => set({ html: e.target.value })} />
        </div>
      );

    case 'send_sms':
    case 'trigger_call':
      return (
        <div className="space-y-2">
          <label className="label">To</label>
          <input className="input" value={(task.config.to as string) ?? '{{mobile}}'} onChange={(e) => set({ to: e.target.value })} />
          {task.type === 'send_sms' && (
            <p className="text-2xs text-muted">Requires an SMS provider to be configured — until then this only logs.</p>
          )}
        </div>
      );

    case 'webhook':
      return (
        <div className="space-y-2">
          <label className="label">URL</label>
          <input className="input" value={(task.config.url as string) ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://" />
          <label className="label mt-2">Method</label>
          <Select value={(task.config.method as string) ?? 'POST'} onChange={(v) => set({ method: v })} options={['POST', 'PUT', 'GET'].map((m) => ({ value: m, label: m }))} />
        </div>
      );

    case 'add_tag':
      return (
        <div>
          <label className="label">Tags (comma separated)</label>
          <input
            className="input"
            value={((task.config.tags as string[]) ?? []).join(', ')}
            onChange={(e) => set({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
          />
        </div>
      );

    case 'ai_action': {
      // A free-text box here was a trap: the engine logs "unknown AI workflow
      // action" and does nothing, so a typo produced a workflow that ran, said
      // it succeeded and had no effect. The placeholder it shipped with
      // suggested `draft_reply`, which has never been one of them.
      const action = (task.config.action as string) ?? '';
      const options = AI_ACTIONS.map((a) => ({ value: a.value, label: a.label }));
      if (action && !AI_ACTIONS.some((a) => a.value === action)) {
        options.push({ value: action, label: `${action} (not recognised)` });
      }
      return (
        <div className="space-y-2">
          <label className="label">Action</label>
          <Select value={action} onChange={(v) => set({ action: v })} options={options} placeholder="Choose an action" />
          <p className="text-2xs text-muted">{AI_ACTIONS.find((a) => a.value === action)?.hint ?? ''}</p>
        </div>
      );
    }

    default:
      return <p className="text-xs text-muted">No extra configuration for this action.</p>;
  }
}

function WorkflowComposer({
  workflowId, modules, onClose, onSaved,
}: {
  workflowId?: string;
  modules: { name: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const isEdit = Boolean(workflowId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [moduleName, setModuleName] = useState(modules[0]?.name ?? '');
  const [trigger, setTrigger] = useState('on_create');
  const [watchFields, setWatchFields] = useState<string[]>([]);
  const [conditions, setConditions] = useState<FilterGroup>({ logic: 'AND', conditions: [] });
  const [schedule, setSchedule] = useState<{ frequency: string; time: string; daysOfWeek: number[]; dayOfMonth: number }>({
    frequency: 'daily', time: '09:00', daysOfWeek: [1], dayOfMonth: 1,
  });
  const [isActive, setIsActive] = useState(true);
  const [tasks, setTasks] = useState<TaskDraft[]>([]);
  const [saving, setSaving] = useState(false);

  const { data: existing } = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => api.workflow(workflowId!),
    enabled: isEdit,
  });

  const { data: moduleMeta } = useQuery({
    queryKey: ['module', moduleName, 'builder'],
    queryFn: () => api.module(moduleName, { includeInactive: true }),
    enabled: Boolean(moduleName),
  });

  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
  const userList = (users ?? []) as unknown as { id: string; fullName: string }[];

  useEffect(() => {
    if (!existing) return;
    const wf = existing as unknown as {
      name: string; description: string | null; trigger: string; module: string;
      watch_fields: string[]; conditions: FilterGroup; schedule: typeof schedule | null; is_active: boolean;
      tasks: { type: string; name: string; delay_minutes: number; delay_field: string | null; delay_direction: 'before' | 'after' | null; config: Record<string, unknown> }[];
    };
    setName(wf.name);
    setDescription(wf.description ?? '');
    setModuleName(wf.module);
    setTrigger(wf.trigger);
    setWatchFields(wf.watch_fields ?? []);
    setConditions(wf.conditions?.conditions ? wf.conditions : { logic: 'AND', conditions: [] });
    if (wf.schedule) setSchedule({ frequency: wf.schedule.frequency ?? 'daily', time: wf.schedule.time ?? '09:00', daysOfWeek: wf.schedule.daysOfWeek ?? [1], dayOfMonth: wf.schedule.dayOfMonth ?? 1 });
    setIsActive(wf.is_active);
    setTasks(wf.tasks.map((t) => ({
      key: Math.random().toString(36).slice(2),
      type: t.type, name: t.name,
      delayMode: t.delay_field ? 'field' : t.delay_minutes > 0 ? 'after' : 'none',
      delayMinutes: t.delay_minutes, delayField: t.delay_field ?? '', delayDirection: t.delay_direction ?? 'after',
      config: t.config,
    })));
  }, [existing]);

  const move = (index: number, dir: -1 | 1): void => {
    setTasks((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async (): Promise<void> => {
    if (!name || !moduleName || !tasks.length) {
      toast.error('Almost there', 'A name, a module and at least one action are required.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        module: moduleName,
        name,
        description: description || undefined,
        trigger,
        watchFields: trigger === 'on_field_change' ? watchFields : [],
        conditions,
        schedule: trigger === 'scheduled' ? schedule : null,
        isActive,
        tasks: tasks.map((t) => ({
          type: t.type,
          name: t.name,
          delayMinutes: t.delayMode === 'after' ? t.delayMinutes : t.delayMode === 'field' ? t.delayMinutes : 0,
          delayField: t.delayMode === 'field' ? t.delayField || null : null,
          delayDirection: t.delayMode === 'field' ? t.delayDirection : null,
          config: t.config,
          isActive: true,
        })),
      };
      if (isEdit) await api.updateWorkflow(workflowId!, payload);
      else await api.createWorkflow(payload);
      toast.success(isEdit ? 'Workflow updated' : 'Workflow created');
      onSaved();
    } catch (err) {
      toast.error('Could not save the workflow', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit “${name || 'workflow'}”` : 'New workflow'}
      size="lg"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Spinner />} {isEdit ? 'Save changes' : 'Create workflow'}
          </button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Module</label>
            <Select value={moduleName} onChange={setModuleName} options={modules.map((m) => ({ value: m.name, label: m.label }))} disabled={isEdit} />
          </div>
        </div>

        <div>
          <label className="label">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Runs</label>
            <Select
              value={trigger}
              onChange={setTrigger}
              options={Object.entries(TRIGGER_LABELS).filter(([k]) => k !== 'manual').map(([value, label]) => ({ value, label }))}
            />
          </div>
          <div className="flex items-end pb-1.5">
            <Toggle checked={isActive} onChange={setIsActive} label="Active" />
          </div>
        </div>

        {trigger === 'on_field_change' && moduleMeta && (
          <div>
            <label className="label">Watch these fields</label>
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              {moduleMeta.fields.filter((f) => f.isActive).map((f) => {
                const active = watchFields.includes(f.name);
                return (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => setWatchFields(active ? watchFields.filter((x) => x !== f.name) : [...watchFields, f.name])}
                    className={cn(
                      'rounded px-2 py-1 text-xs transition-colors',
                      active ? 'bg-brand-100 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                    )}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {trigger === 'scheduled' && (
          <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-700">
            <div>
              <label className="label">Frequency</label>
              <Select
                value={schedule.frequency}
                onChange={(v) => setSchedule({ ...schedule, frequency: v })}
                options={['hourly', 'daily', 'weekly', 'monthly'].map((f) => ({ value: f, label: f }))}
              />
            </div>
            {schedule.frequency !== 'hourly' && (
              <div>
                <label className="label">Time</label>
                <input type="time" className="input" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
              </div>
            )}
            {schedule.frequency === 'monthly' && (
              <div>
                <label className="label">Day of month</label>
                <input type="number" min={1} max={31} className="input" value={schedule.dayOfMonth} onChange={(e) => setSchedule({ ...schedule, dayOfMonth: Number(e.target.value) })} />
              </div>
            )}
          </div>
        )}

        {moduleMeta && (
          <div>
            <label className="label">Only run when</label>
            <FilterBuilder module={moduleMeta} value={conditions} onChange={setConditions} />
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center gap-2">
            <p className="text-sm font-medium">Actions</p>
            <Select
              value=""
              onChange={(type) => setTasks([...tasks, newTask(type)])}
              placeholder="+ Add an action"
              className="ml-auto w-56"
              options={Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </div>

          {!tasks.length && (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-muted dark:border-slate-700">
              No actions yet — add at least one above.
            </p>
          )}

          <ol className="space-y-2">
            {tasks.map((task, i) => (
              <li key={task.key} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-center gap-2">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-2xs font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                    {i + 1}
                  </span>
                  <input
                    className="input flex-1"
                    value={task.name}
                    onChange={(e) => setTasks(tasks.map((t) => (t.key === task.key ? { ...t, name: e.target.value } : t)))}
                  />
                  <Badge>{TASK_TYPE_LABELS[task.type] ?? task.type}</Badge>
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="btn-ghost p-1 disabled:opacity-30">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === tasks.length - 1} className="btn-ghost p-1 disabled:opacity-30">↓</button>
                  <button onClick={() => setTasks(tasks.filter((t) => t.key !== task.key))} className="btn-ghost p-1.5 text-slate-400 hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-3 gap-2 border-b border-slate-100 pb-2 dark:border-slate-800">
                  <Select
                    value={task.delayMode}
                    onChange={(v) => setTasks(tasks.map((t) => (t.key === task.key ? { ...t, delayMode: v as TaskDraft['delayMode'] } : t)))}
                    options={[
                      { value: 'none', label: 'Immediately' },
                      { value: 'after', label: 'After a delay' },
                      { value: 'field', label: 'Relative to a date field' },
                    ]}
                  />
                  {task.delayMode === 'after' && (
                    <input
                      type="number" className="input col-span-2" placeholder="Minutes"
                      value={task.delayMinutes}
                      onChange={(e) => setTasks(tasks.map((t) => (t.key === task.key ? { ...t, delayMinutes: Number(e.target.value) } : t)))}
                    />
                  )}
                  {task.delayMode === 'field' && moduleMeta && (
                    <>
                      <input
                        type="number" className="input" placeholder="Minutes"
                        value={task.delayMinutes}
                        onChange={(e) => setTasks(tasks.map((t) => (t.key === task.key ? { ...t, delayMinutes: Number(e.target.value) } : t)))}
                      />
                      <Select
                        value={task.delayDirection}
                        onChange={(v) => setTasks(tasks.map((t) => (t.key === task.key ? { ...t, delayDirection: v as 'before' | 'after' } : t)))}
                        options={[{ value: 'before', label: 'before' }, { value: 'after', label: 'after' }]}
                      />
                      <Select
                        value={task.delayField}
                        onChange={(v) => setTasks(tasks.map((t) => (t.key === task.key ? { ...t, delayField: v } : t)))}
                        placeholder="— field —"
                        options={moduleMeta.fields.filter((f) => f.uitype === 'date' || f.uitype === 'datetime').map((f) => ({ value: f.name, label: f.label }))}
                      />
                    </>
                  )}
                </div>

                <div className="mt-2">
                  <TaskConfigFields
                    task={task}
                    module={moduleMeta}
                    users={userList}
                    onChange={(config) => setTasks(tasks.map((t) => (t.key === task.key ? { ...t, config } : t)))}
                  />
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Modal>
  );
}
