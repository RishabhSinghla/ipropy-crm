import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText, RefreshCw, Save } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Select, Skeleton, Spinner } from '../../components/ui';

/**
 * Approved templates, and what fills their blanks.
 *
 * Meta approves the wording and freezes it; all this screen decides is what
 * goes in each `{{1}}`. That is set per template and read from the same Field
 * Manager metadata every other screen reads, so a field renamed in Modules &
 * Fields keeps working here instead of silently sending an empty gap.
 *
 * Syncing pulls the approved list from whichever provider is switched on and
 * **never touches a mapping** — the provider owns the wording, the CRM owns
 * the blanks.
 */

/** The four things a blank can be filled from, in the order they get used. */
function sourceOptions(fields: { name: string; label: string }[]): { value: string; label: string }[] {
  return [
    { value: '', label: '— nothing yet —' },
    ...fields.map((field) => ({ value: `field:${field.name}`, label: field.label })),
    { value: 'agent:name', label: 'The agent sending it' },
    { value: 'org:name', label: 'The business name' },
  ];
}

export default function WhatsAppTemplatesAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [module, setModule] = useState('leads');
  const autoSyncStarted = useRef(false);

  const { data: status } = useQuery({ queryKey: ['wa-biz', 'status'], queryFn: () => api.waBizStatus() });
  const { data: templates, isLoading } = useQuery({
    queryKey: ['wa-biz', 'templates', 'saved'],
    queryFn: () => api.waBizSavedTemplates(),
  });
  const { data: meta } = useQuery({
    queryKey: ['module', module],
    queryFn: () => api.module(module),
  });

  const fields = useMemo(
    () => (meta?.fields ?? [])
      .filter((field) => field.isActive && field.displayType !== 'hidden')
      .map((field) => ({ name: field.name, label: field.label })),
    [meta],
  );

  const sync = useMutation({
    mutationFn: () => api.waBizSyncTemplates(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['wa-biz', 'templates'] });
      if (result.skipped) toast.error('Nothing to sync', result.skipped);
      else toast.success(
        'Templates synced',
        `${result.added.length} new, ${result.updated.length} updated, ${result.removed.length} retired. Only provider-approved templates are listed.`,
      );
    },
    onError: (error: Error) => toast.error('Could not sync templates', error.message),
  });

  // The provider is the source of truth for approval and removal. Refresh once
  // when this page opens so an admin does not have to discover that stale rows
  // need a manual sync before the table matches WhatsMarketing.
  useEffect(() => {
    if (status?.connected && !autoSyncStarted.current) {
      autoSyncStarted.current = true;
      sync.mutate();
    }
  }, [status?.connected, sync.mutate]);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">WhatsApp Templates</h1>
          <p className="text-sm text-muted">
            {templates?.length ?? 0} approved templates from WhatsMarketing. Rejected, pending, and removed templates are hidden.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={module}
            onChange={setModule}
            options={[{ value: 'leads', label: 'Contacts' }, { value: 'properties', label: 'Inventory' }]}
          />
          <button className="btn-secondary btn-sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync from provider
          </button>
        </div>
      </div>

      {status && !status.connected && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          No WhatsApp Business provider is switched on yet, so there is nothing to sync from.
          Add one in Admin → Integrations.
        </p>
      )}

      {isLoading && <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}</div>}

      {!isLoading && !(templates ?? []).length && (
        <div className="card p-6 text-center">
          <MessageSquareText className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm font-semibold">No templates yet</p>
          <p className="mt-1 text-xs text-muted">
            Templates are created and approved in your provider&rsquo;s dashboard, then synced here.
          </p>
        </div>
      )}

      {!isLoading && Boolean((templates ?? []).length) && (
        <div className="card overflow-x-auto">
          <div className="min-w-[900px]">
            <div className="grid grid-cols-[42px_88px_minmax(160px,1fr)_100px_94px_170px] gap-3 border-b bg-slate-50 px-4 py-2 text-2xs font-bold uppercase tracking-wide text-slate-500 dark:bg-slate-800/70">
              <span>#</span><span>WhatsMarketing ID</span><span>Template name</span><span>Category</span><span>Status</span><span>Updated at</span>
            </div>
            {(templates ?? []).map((template, index) => (
              <TemplateCard
                key={template.id}
                serial={index + 1}
                template={template}
                module={module}
                fields={fields}
                onSaved={() => queryClient.invalidateQueries({ queryKey: ['wa-biz', 'templates'] })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatProviderDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function TemplateCard({ serial, template, module, fields, onSaved }: {
  serial: number;
  template: {
    id: string; name: string; language: string; category: string; status: string;
    bodyText: string; variableCount: number; variableMap: Record<string, string>;
    providerTemplateId: string | null; providerRowId: string | null; providerUpdatedAt: string | null;
  };
  module: string;
  fields: { name: string; label: string }[];
  onSaved: () => void;
}): JSX.Element {
  const [map, setMap] = useState<Record<string, string>>(template.variableMap ?? {});
  const options = sourceOptions(fields);

  const save = useMutation({
    mutationFn: () => api.waBizSaveMapping(template.id, module, map),
    onSuccess: () => { toast.success('Mapping saved'); onSaved(); },
    onError: (error: Error) => toast.error('Could not save that mapping', error.message),
  });

  const approved = template.status.toUpperCase() === 'APPROVED';

  return (
    <section className="border-b last:border-b-0">
      <header className="grid grid-cols-[42px_88px_minmax(160px,1fr)_100px_94px_170px] items-center gap-3 px-4 py-3 text-xs">
        <span className="font-mono text-muted">{serial}</span>
        <span className="font-mono text-muted">{template.providerRowId ?? '—'}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold" title={template.name}>{template.name}</p>
          <p className="text-2xs text-muted">{template.language}{template.providerTemplateId && template.providerTemplateId !== template.providerRowId ? ` · Meta ID ${template.providerTemplateId}` : ''}</p>
        </div>
        <span>{template.category}</span>
        <span className={cn(
          'rounded px-2 py-0.5 text-2xs font-bold',
          approved
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
            : 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
        )}>
          {template.status}
        </span>
        <time className="text-muted" dateTime={template.providerUpdatedAt ?? undefined}>
          {formatProviderDate(template.providerUpdatedAt)}
        </time>
      </header>

      <details className="border-t px-4 py-2">
        <summary className="cursor-pointer select-none text-xs font-semibold text-violet-700 dark:text-violet-300">
          Preview and variable mapping
        </summary>
        <div className="pb-2 pt-3">
          <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
            {template.bodyText}
          </p>

      {template.variableCount === 0 ? (
        <p className="mt-3 text-xs text-muted">This template has no blanks to fill.</p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {Array.from({ length: template.variableCount }).map((_, index) => {
              const slot = String(index + 1);
              return (
                <label key={slot} className="block">
                  <span className="mb-1 block text-2xs font-bold uppercase tracking-wide text-slate-500">
                    {`{{${slot}}}`}
                  </span>
                  <Select
                    value={map[slot] ?? ''}
                    onChange={(value) => setMap((current) => ({ ...current, [slot]: value }))}
                    options={options}
                  />
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-2xs text-muted">
              A blank with nothing mapped stops the send, named — WhatsApp refuses it anyway,
              and &ldquo;message failed&rdquo; tells nobody which field was empty.
            </p>
            <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
            </button>
          </div>
        </>
      )}
        </div>
      </details>
    </section>
  );
}
