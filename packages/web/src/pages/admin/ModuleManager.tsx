import { type JSX, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Blocks, Info, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { badgeVars } from '../../lib/color';
import { cn, groupModules } from '../../lib/utils';
import { Badge, Modal, Skeleton, Spinner, Toggle } from '../../components/ui';
import { ModuleIcon } from '../../components/Layout';

interface ModuleRow {
  id: string; name: string; label: string; singularLabel: string;
  icon: string; color: string; isActive: boolean; isCustom: boolean; isCore: boolean;
  disabledReason: string | null; menuGroup: string;
  fieldCount: number; recordCount: number; dependents: string[];
}

export default function ModuleManager(): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { bootstrap } = useApp();
  const [confirming, setConfirming] = useState<ModuleRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const { data: modules, isLoading } = useQuery({
    queryKey: ['all-modules'],
    queryFn: () => api.allModules(),
  });

  const apply = async (module: ModuleRow, isActive: boolean, why?: string): Promise<void> => {
    setBusy(module.name);
    try {
      const result = await api.toggleModule(module.name, isActive, why);
      toast.success(isActive ? `${module.label} enabled` : `${module.label} disabled`, result.message);
      await queryClient.invalidateQueries({ queryKey: ['all-modules'] });
      await queryClient.invalidateQueries({ queryKey: ['field-modules'] });
      // Refresh the app shell so the sidebar reflects the change immediately.
      await bootstrap();
    } catch (err) {
      toast.error('Could not update the module', (err as Error).message);
    } finally {
      setBusy(null);
      setConfirming(null);
      setReason('');
    }
  };

  const grouped = groupModules(
    (modules ?? []).map((m) => ({ ...m, sequence: 0 })) as (ModuleRow & { sequence: number })[],
  );
  const activeCount = (modules ?? []).filter((m) => m.isActive).length;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Modules</h1>
          <p className="text-sm text-muted">
            Switch off what you don't use. Disabling hides a module everywhere — nav, search, reports
            and the API — but keeps its data, so re-enabling restores it exactly.
          </p>
        </div>
        <Badge className="ml-auto">
          {activeCount} of {modules?.length ?? 0} enabled
        </Badge>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([group, list]) => (
            <div key={group} className="card overflow-hidden">
              <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/40">
                <p className="text-2xs font-semibold uppercase tracking-wide text-muted">{group}</p>
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.map((module) => (
                  <li
                    key={module.name}
                    className={cn('flex items-center gap-3 p-3', !module.isActive && 'bg-slate-50/60 dark:bg-slate-900/40')}
                  >
                    <span
                      className={cn(
                        'badge-tinted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                        !module.isActive && 'opacity-40',
                      )}
                      style={badgeVars(module.color)}
                    >
                      <ModuleIcon name={module.icon} className="h-4.5 w-4.5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn('text-sm font-medium', !module.isActive && 'text-muted')}>
                          {module.label}
                        </span>
                        {module.isCustom && <Badge color="#6366f1">Custom</Badge>}
                        {module.isCore && (
                          <Badge color="#94a3b8">
                            <Lock className="h-2.5 w-2.5" /> Core
                          </Badge>
                        )}
                        {!module.isActive && <Badge color="#ef4444">Disabled</Badge>}
                      </div>
                      {/* Clamped: Leads is referenced by seven other modules,
                          which on a phone turned one card into a paragraph. */}
                      <p className="mt-0.5 line-clamp-2 text-2xs text-muted tnum" title={module.dependents.join(', ')}>
                        {module.fieldCount} fields · {module.recordCount.toLocaleString('en-IN')} records
                        {module.dependents.length > 0 && ` · referenced by ${module.dependents.join(', ')}`}
                      </p>
                      {!module.isActive && module.disabledReason && (
                        <p className="mt-0.5 text-2xs italic text-muted">“{module.disabledReason}”</p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => navigate(`/admin/fields?module=${encodeURIComponent(module.name)}`)}
                        aria-label={`Manage fields for ${module.label}`}
                      >
                        <Blocks className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Fields</span>
                      </button>
                      {busy === module.name && <Spinner className="h-3.5 w-3.5 text-slate-400" />}
                      <Toggle
                        checked={module.isActive}
                        disabled={module.isCore || busy === module.name}
                        onChange={(next) => {
                          // Turning a module off can hide live data — confirm first.
                          if (!next) setConfirming(module);
                          else void apply(module, true);
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900 text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <p>
            <strong>Leads &amp; Contacts</strong> is core — the rest of the CRM reads from it, so it
            cannot be switched off.
          </p>
        </div>
      </div>

      <Modal
        open={Boolean(confirming)}
        onClose={() => { setConfirming(null); setReason(''); }}
        title={`Disable ${confirming?.label}?`}
        size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => { setConfirming(null); setReason(''); }}>
              Cancel
            </button>
            <button
              className="btn-danger"
              disabled={busy !== null}
              onClick={() => confirming && void apply(confirming, false, reason || undefined)}
            >
              {busy && <Spinner />} Disable module
            </button>
          </>
        }
      >
        {confirming && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="text-xs text-amber-800 dark:text-amber-300">
                <p>
                  {confirming.recordCount.toLocaleString('en-IN')} {confirming.label.toLowerCase()} records
                  will be hidden from the app and the API.
                </p>
                <p className="mt-1"><strong>Nothing is deleted.</strong> Re-enabling brings everything back.</p>
                {confirming.dependents.length > 0 && (
                  <p className="mt-1">
                    {confirming.dependents.join(', ')} look up {confirming.label.toLowerCase()} — those
                    fields will show empty until you re-enable it.
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className="label">Reason (optional)</label>
              <input
                className="input"
                placeholder="e.g. Not used by our team"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
              />
              <p className="mt-1 text-2xs text-muted">
                Shown on this screen so colleagues know why it's off.
              </p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
