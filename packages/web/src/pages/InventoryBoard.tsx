import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatArea, formatIndianPrice } from '@ipropy/shared';
import { Building2, Lock, LockOpen, Sparkles, Unlock } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { badgeVars } from '../lib/color';
import { cn } from '../lib/utils';
import { Badge, EmptyState, Modal, Select, Skeleton, Spinner } from '../components/ui';
import { ReferencePicker } from '../components/FieldRenderer';

interface Unit {
  id: string; label: string; tower: string | null; floor: number | null;
  unit_number: string | null; configuration: string | null; status: string;
  carpet_area: number | null; total_price: number | null; base_price: number | null;
  facing: string | null; corner_unit: boolean; blocked_until: string | null;
  blocked_for_label: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  Available: '#22c55e',
  Held: '#f59e0b',
  Blocked: '#f97316',
  Booked: '#3b82f6',
  'Agreement Done': '#8b5cf6',
  Registered: '#14b8a6',
  Sold: '#64748b',
  'Not For Sale': '#a1a1aa',
};

export default function InventoryBoard(): JSX.Element {
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Unit | null>(null);

  const { data: projects } = useQuery({
    queryKey: ['records', 'projects', 'inventory-picker'],
    queryFn: () => api.list('projects', { pageSize: 100, sortBy: 'name', sortDir: 'asc' }),
  });

  const activeProject = projectId ?? projects?.rows[0]?.id;

  const { data, isLoading } = useQuery({
    queryKey: ['inventory', activeProject],
    queryFn: () => api.inventoryBoard(activeProject!),
    enabled: Boolean(activeProject),
  });

  if (!projects?.rows.length) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Building2 className="h-10 w-10" />}
          title="No projects yet"
          body="Create a project and add units to see the stack plan."
          action={<Link to="/projects/new" className="btn-primary btn-sm">Create a project</Link>}
        />
      </div>
    );
  }

  const towers = (data?.towers ?? []) as unknown as {
    name: string;
    floors: { floor: number; units: Unit[] }[];
  }[];

  const summary = (data?.summary ?? []) as unknown as { status: string; count: number; value: number }[];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-positive dark:bg-emerald-950">
            <Building2 className="h-4.5 w-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Inventory Board</h1>
            <p className="text-xs text-muted tnum">{data?.total ?? 0} units</p>
          </div>
        </div>

        <Select
          value={activeProject}
          onChange={(id) => navigate(`/inventory/${id}`)}
          options={(projects.rows ?? []).map((p) => ({ value: p.id, label: p.label }))}
          className="w-full sm:w-64"
        />
      </div>

      {/* Status summary */}
      <div className="mb-4 flex flex-wrap gap-2">
        {summary.map((s) => (
          <div
            key={s.status}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: STATUS_COLOR[s.status] ?? '#94a3b8' }} />
            <div>
              <p className="text-xs font-medium">{s.status}</p>
              <p className="text-2xs text-muted tnum">
                {s.count} units · {formatIndianPrice(Number(s.value))}
              </p>
            </div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : towers.length === 0 ? (
        <EmptyState title="No units in this project" body="Add inventory to see the stack plan." />
      ) : (
        <div className="space-y-5">
          {towers.map((tower) => (
            <div key={tower.name} className="card overflow-hidden">
              <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
                <p className="text-sm font-medium">{tower.name}</p>
              </div>
              <div className="overflow-x-auto p-3">
                <div className="space-y-1.5">
                  {tower.floors.map((floor) => (
                    <div key={floor.floor} className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-right text-2xs font-medium text-muted tnum">
                        Floor {floor.floor}
                      </span>
                      <div className="flex flex-1 flex-wrap gap-1.5">
                        {floor.units.map((unit) => (
                          <button
                            key={unit.id}
                            onClick={() => setSelected(unit)}
                            className="group relative flex h-14 w-20 shrink-0 flex-col justify-center rounded-lg border-2 px-2 text-left transition-all hover:scale-105 hover:shadow-md sm:w-[5.5rem]"
                            // The tile keeps its full-strength status border —
                            // that colour coding is the whole point of the
                            // board. Only the price text switches to the
                            // derived readable foreground, via .text-tinted.
                            style={{
                              ...badgeVars(STATUS_COLOR[unit.status] ?? '#94a3b8'),
                              borderColor: STATUS_COLOR[unit.status] ?? '#94a3b8',
                              backgroundColor: `${STATUS_COLOR[unit.status] ?? '#94a3b8'}12`,
                            }}
                            title={`${unit.label}\n${unit.status}\n${formatIndianPrice(unit.total_price ?? 0)}`}
                          >
                            <span className="truncate text-xs font-semibold tnum">{unit.unit_number}</span>
                            <span className="truncate text-[10px] text-slate-500">{unit.configuration}</span>
                            <span className="text-tinted truncate text-[10px] font-medium tnum">
                              {unit.total_price ? shortPrice(unit.total_price) : '—'}
                            </span>
                            {unit.corner_unit && (
                              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" title="Corner unit" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <UnitModal
          unit={selected}
          onClose={() => setSelected(null)}
          projectId={activeProject!}
        />
      )}
    </div>
  );
}

function shortPrice(value: number): string {
  if (value >= 1e7) return `₹${(value / 1e7).toFixed(2)}Cr`;
  if (value >= 1e5) return `₹${(value / 1e5).toFixed(0)}L`;
  return `₹${value}`;
}

function UnitModal({
  unit, onClose, projectId,
}: { unit: Unit; onClose: () => void; projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const { aiAvailable } = useApp();
  const [leadId, setLeadId] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

  const { data: buyers, isLoading: loadingBuyers } = useQuery({
    queryKey: ['buyers-for', unit.id],
    queryFn: () => api.buyersForProperty(unit.id),
    enabled: unit.status === 'Available',
  });

  const leadField = {
    id: 'lead', moduleId: '', moduleName: '', blockId: null, name: 'lead_id',
    label: 'Lead', uitype: 'reference' as const, storage: 'column' as const, columnName: 'lead_id',
    sequence: 0, isMandatory: false, isReadonly: false, isUnique: false, isCustom: false, isActive: true,
    displayType: 'default' as const, defaultValue: null, maxLength: null, helpText: null,
    config: { referenceModules: ['leads'] }, quickCreate: false, massEditable: true, searchable: false,
  };

  const act = async (release: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.blockUnit(unit.id, { leadId, days, release });
      toast.success(release ? 'Unit released' : `Unit blocked for ${days} days`);
      void queryClient.invalidateQueries({ queryKey: ['inventory', projectId] });
      onClose();
    } catch (err) {
      toast.error('Action failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isBlocked = ['Held', 'Blocked'].includes(unit.status);
  const canBlock = unit.status === 'Available';

  return (
    <Modal
      open
      onClose={onClose}
      title={unit.label}
      size="md"
      footer={
        <>
          <Link to={`/properties/${unit.id}`} className="btn-secondary">Open record</Link>
          {isBlocked && (
            <button className="btn-secondary" onClick={() => void act(true)} disabled={busy}>
              {busy ? <Spinner /> : <Unlock className="h-4 w-4" />} Release
            </button>
          )}
          {canBlock && (
            <button className="btn-primary" onClick={() => void act(false)} disabled={busy}>
              {busy ? <Spinner /> : <Lock className="h-4 w-4" />} Block unit
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {[
            { label: 'Status', value: <Badge color={STATUS_COLOR[unit.status]}>{unit.status}</Badge> },
            { label: 'Configuration', value: unit.configuration ?? '—' },
            { label: 'Carpet area', value: unit.carpet_area ? formatArea(unit.carpet_area) : '—' },
            { label: 'All-inclusive price', value: unit.total_price ? formatIndianPrice(unit.total_price) : '—' },
            { label: 'Facing', value: unit.facing ?? '—' },
            { label: 'Floor', value: unit.floor ?? '—' },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-2xs uppercase tracking-wide text-muted">{item.label}</p>
              <p className="mt-0.5 text-sm font-medium">{item.value}</p>
            </div>
          ))}
        </div>

        {isBlocked && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
            <p className="text-xs text-amber-800 dark:text-amber-300">
              Blocked{unit.blocked_for_label ? ` for ${unit.blocked_for_label}` : ''}
              {unit.blocked_until ? ` until ${new Date(unit.blocked_until).toLocaleDateString('en-IN')}` : ''}.
              It releases automatically when the hold expires.
            </p>
          </div>
        )}

        {canBlock && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">Block this unit</p>
            <div>
              <label className="label">For which lead?</label>
              <ReferencePicker
                field={leadField as never}
                value={leadId}
                onChange={setLeadId}
                placeholder="Search leads…"
              />
            </div>
            <div>
              <label className="label">Hold period</label>
              <Select
                value={String(days)}
                onChange={(v) => setDays(Number(v))}
                options={[3, 7, 14, 21, 30].map((d) => ({ value: String(d), label: `${d} days` }))}
              />
            </div>
          </div>
        )}

        {unit.status === 'Available' && (
          <div>
            <div className="mb-2 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-brand-500" />
              <p className="text-xs font-medium">Buyers who match this unit</p>
            </div>
            {loadingBuyers ? (
              <Skeleton className="h-20 w-full" />
            ) : !buyers?.buyers.length ? (
              <p className="rounded-lg border border-dashed border-slate-200 py-4 text-center text-xs text-muted dark:border-slate-700">
                No open leads match this unit's price and configuration.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {buyers.buyers.map((raw) => {
                  const b = raw as unknown as { recordId: string; label: string; score: number; reasons: string[] };
                  return (
                    <li key={b.recordId} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                      <div className="flex items-center justify-between gap-2">
                        <Link to={`/leads/${b.recordId}`} className="truncate text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                          {b.label}
                        </Link>
                        <Badge color={b.score >= 75 ? '#22c55e' : '#f59e0b'}>{b.score}</Badge>
                      </div>
                      {b.reasons[0] && <p className="mt-0.5 text-2xs text-muted">{b.reasons[0]}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
