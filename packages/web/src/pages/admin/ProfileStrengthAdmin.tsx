import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAnswerable, strengthWeight } from '@ipropy/shared';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';

export default function ProfileStrengthAdmin() {
  const { modules } = useApp();
  const entities = modules.filter((module) => module.isEntity);
  const [selected, setSelected] = useState(entities[0]?.name ?? '');
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const cache = useQueryClient();
  const { data: meta } = useQuery({ queryKey: ['strength-master', selected], queryFn: () => api.module(selected), enabled: Boolean(selected) });
  const fields = meta?.fields.filter(isAnswerable) ?? [];
  const weight = (id: string, fallback: number) => draft[id] ?? fallback;
  const total = fields.reduce((sum, field) => sum + weight(field.id, strengthWeight(field)), 0);
  const save = async () => {
    setSaving(true);
    try {
      for (const field of fields) {
        if (draft[field.id] !== undefined) await api.updateField(field.id, { config: { ...field.config, strengthWeight: draft[field.id] } });
      }
      await cache.invalidateQueries();
      setDraft({});
      toast.success('Profile strength weights saved');
    } catch (error) { toast.error('Could not save weights', (error as Error).message); }
    finally { setSaving(false); }
  };
  return <section className="space-y-4 p-4">
    <h1 className="text-xl font-bold">Profile strength master</h1>
    <p className="text-sm text-muted">Set each field's relative percentage weight (0–100). The contribution column shows its share of the final score. Zero excludes a field. Existing records recalculate automatically; saves are never blocked.</p>
    <select aria-label="Profile strength module" className="input max-w-xs" value={selected} onChange={(event) => { setSelected(event.target.value); setDraft({}); }}>{entities.map((module) => <option key={module.name} value={module.name}>{module.label}</option>)}</select>
    <table className="w-full text-sm"><thead><tr><th className="text-left">Field</th><th>Weight</th><th>Contribution</th></tr></thead><tbody>{fields.map((field) => <tr key={field.id} className="border-b"><td className="py-2">{field.label}</td><td><input aria-label={`${field.label} weight`} type="number" min="0" max="100" className="input mx-auto w-24" value={weight(field.id, strengthWeight(field))} onChange={(event) => setDraft({ ...draft, [field.id]: Math.max(0, Math.min(100, Number(event.target.value))) })} /></td><td className="text-center">{total ? (100 * weight(field.id, strengthWeight(field)) / total).toFixed(1) : '0'}%</td></tr>)}</tbody></table>
    <button disabled={saving || !Object.keys(draft).length} className="btn-primary" onClick={() => void save()}>{saving ? 'Saving…' : 'Save weights'}</button>
  </section>;
}
