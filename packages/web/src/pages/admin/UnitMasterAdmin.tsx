import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { Spinner, Tabs } from '../../components/ui';

type Kind = 'area' | 'budget_demand';
type Unit = { id?: string; value: string; label: string; factorSqft: number | null; isActive: boolean; isDefault: boolean };

export default function UnitMasterAdmin(): JSX.Element {
  const [kind, setKind] = useState<Kind>('area');
  const [units, setUnits] = useState<Unit[]>([]);
  const [saving, setSaving] = useState(false);
  const client = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['unit-master', kind], queryFn: () => api.unitMaster(kind) });
  useEffect(() => { if (data) setUnits(data); }, [data]);
  const save = async (): Promise<void> => {
    setSaving(true);
    try { await api.saveUnitMaster(kind, units); toast.success('Unit master saved', 'Every linked field now uses this list.'); await client.invalidateQueries({ queryKey: ['unit-master', kind] }); }
    catch (err) { toast.error('Could not save units', (err as Error).message); } finally { setSaving(false); }
  };
  const update = (i: number, patch: Partial<Unit>): void => setUnits((old) => old.map((u, n) => n === i ? { ...u, ...patch } : u));
  return <div className="p-4 sm:p-6">
    <div className="mb-4 flex items-center gap-3"><div><h1 className="text-lg font-semibold">Area & Pricing Units</h1><p className="text-sm text-muted">One reusable list for all present and future area, budget and demand fields.</p></div><button className="btn-primary btn-sm ml-auto" onClick={() => void save()} disabled={saving}>{saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save</button></div>
    <Tabs active={kind} onChange={(v) => setKind(v as Kind)} tabs={[{ key: 'area', label: 'Area / Size' }, { key: 'budget_demand', label: 'Budget / Demand' }]} />
    <div className="card mt-4 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs text-muted"><th className="p-3">Name</th><th className="p-3">Saved value</th>{kind === 'area' && <th className="p-3">Sq. Ft. factor</th>}<th className="p-3">Available</th><th className="p-3">Default</th></tr></thead><tbody>{isLoading ? <tr><td className="p-4" colSpan={5}>Loading…</td></tr> : units.map((unit, i) => <tr key={unit.id ?? `${unit.value}-${i}`} className="border-b last:border-0"><td className="p-2"><input className="input h-8" value={unit.label} onChange={(e) => update(i, { label: e.target.value })} /></td><td className="p-2"><input className="input h-8 font-mono text-xs" disabled={Boolean(unit.id)} value={unit.value} onChange={(e) => update(i, { value: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></td>{kind === 'area' && <td className="p-2"><input className="input h-8 w-28" type="number" value={unit.factorSqft ?? ''} onChange={(e) => update(i, { factorSqft: e.target.value ? Number(e.target.value) : null })} /></td>}<td className="p-2"><input type="checkbox" checked={unit.isActive} onChange={(e) => update(i, { isActive: e.target.checked })} /></td><td className="p-2"><input type="radio" name={`default-${kind}`} checked={unit.isDefault} onChange={() => setUnits((old) => old.map((u, n) => ({ ...u, isDefault: n === i })))} /></td></tr>)}</tbody></table><button className="btn-ghost btn-sm m-3" onClick={() => setUnits((old) => [...old, { value: '', label: '', factorSqft: null, isActive: true, isDefault: false }])}><Plus className="h-3.5 w-3.5" /> Add unit</button></div>
  </div>;
}
