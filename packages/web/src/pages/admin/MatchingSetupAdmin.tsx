import { type JSX, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, Save, Trash2 } from 'lucide-react';
import { api, type MatchingFieldPair } from '../../lib/api';
import { toast } from '../../lib/store';
import { Select, Skeleton, Spinner } from '../../components/ui';

/**
 * Which Contacts field is compared against which Properties field when the
 * CRM decides a buyer suits a unit (or a unit suits a buyer), and how much
 * grace a price/currency pair gets before it counts as out of budget.
 *
 * Before this page existed the comparison was fixed in code — the owner's
 * own words were that the matching "is working inside, and I don't know how"
 * — so the same two dials that mattered most (which field means "bedrooms",
 * and how forgiving a price comparison is) are what this exposes. Saved
 * through the same `ipy_setting` mechanism as every other admin setting, so
 * an edit here takes effect on the next match, not the next deploy.
 */
export default function MatchingSetupAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const [fieldMap, setFieldMap] = useState<MatchingFieldPair[]>([]);
  const [gracePercent, setGracePercent] = useState(10);
  const [areaGracePercent, setAreaGracePercent] = useState(15);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['matching-config'], queryFn: () => api.matchingConfig() });

  useEffect(() => {
    if (!data) return;
    setFieldMap(data.fieldMap);
    setGracePercent(data.priceGracePercent);
    setAreaGracePercent(data.areaGracePercent);
    setDirty(false);
  }, [data]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.saveMatchingConfig(
        fieldMap.filter((p) => p.contactFieldId && p.propertyFieldId), gracePercent, areaGracePercent,
      );
      toast.success('Matching setup saved', 'The next match uses these mappings.');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['matching-config'] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const setPair = (i: number, patch: Partial<MatchingFieldPair>): void => {
    setFieldMap((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const removePair = (i: number): void => {
    setFieldMap((rows) => rows.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const addPair = (): void => {
    setFieldMap((rows) => [...rows, { contactField: '', propertyField: '' }]);
    setDirty(true);
  };

  const propertyUitype = (id: string | undefined): string | undefined =>
    data?.propertyFields.find((f) => f.id === id)?.uitype;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Matching Setup</h1>
          <p className="text-sm text-muted">
            Which Contact field is compared against which Property field when the CRM
            matches buyers to inventory, and how much price/currency grace to allow.
          </p>
        </div>
        <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm ml-auto">
          {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
        </button>
      </div>

      {isLoading || !data ? (
        <div className="card space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : (
        <>
          <div className="card mb-4 p-4">
            <label className="label" htmlFor="matching-grace">Price / currency grace</label>
            <div className="mt-1 flex items-center gap-3">
              <input
                id="matching-grace"
                type="number"
                min={0}
                max={100}
                value={gracePercent}
                onChange={(e) => { setGracePercent(Math.max(0, Math.min(100, Number(e.target.value) || 0))); setDirty(true); }}
                className="input w-24"
              />
              <span className="text-sm text-muted">%</span>
              <span className="text-xs text-muted">
                A property up to {gracePercent}% above a buyer's stated budget still counts as a fit.
                Applies to whichever pair below maps to a price/currency field.
              </span>
            </div>
            <label className="label mt-4" htmlFor="matching-area-grace">Area / size tolerance</label>
            <div className="mt-1 flex items-center gap-3">
              <input id="matching-area-grace" type="number" min={0} max={100} value={areaGracePercent} onChange={(e) => { setAreaGracePercent(Math.max(0, Math.min(100, Number(e.target.value) || 0))); setDirty(true); }} className="input w-24" />
              <span className="text-sm text-muted">%</span>
              <span className="text-xs text-muted">A property within ±{areaGracePercent}% of the requested area counts as a fit.</span>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
              <Link2 className="h-4 w-4 text-brand-500" />
              <span className="text-sm font-medium">Field mappings</span>
              <button type="button" onClick={addPair} className="btn-ghost btn-sm ml-auto">
                <Plus className="h-3.5 w-3.5" /> Add mapping
              </button>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {fieldMap.map((pair, i) => {
                const uitype = propertyUitype(pair.propertyFieldId);
                const isPrice = uitype === 'currency';
                const isBedrooms = pair.contactField === 'configuration';
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 p-3">
                    <span className="w-20 shrink-0 text-xs font-medium text-muted">Contact</span>
                    <Select
                      value={pair.contactFieldId ?? ''}
                      onChange={(id) => setPair(i, { contactFieldId: id, contactField: data.contactFields.find((f) => f.id === id)?.name ?? '' })}
                      placeholder="— Select a field —"
                      options={data.contactFields.map((f) => ({ value: f.id, label: f.label }))}
                      className="w-48 py-1.5 text-sm"
                    />
                    <span className="text-xs text-muted">maps to</span>
                    <span className="w-20 shrink-0 text-xs font-medium text-muted">Property</span>
                    <Select
                      value={pair.propertyFieldId ?? ''}
                      onChange={(id) => setPair(i, { propertyFieldId: id, propertyField: data.propertyFields.find((f) => f.id === id)?.name ?? '' })}
                      placeholder="— Select a field —"
                      options={data.propertyFields.map((f) => ({ value: f.id, label: f.label }))}
                      className="w-48 py-1.5 text-sm"
                    />
                    {isBedrooms && (
                      <span className="rounded bg-brand-50 px-1.5 py-0.5 text-2xs font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                        drives bedroom matching
                      </span>
                    )}
                    {isPrice && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-2xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                        uses the {gracePercent}% grace
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePair(i)}
                      aria-label="Remove mapping"
                      className="btn-ghost btn-sm ml-auto text-red-600 dark:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              {fieldMap.length === 0 && (
                <p className="p-4 text-sm text-muted">No mappings yet — add one above.</p>
              )}
            </div>
          </div>

          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted dark:bg-slate-900">
            The pair whose Contact side is the buyer&apos;s bedroom wish list drives BHK matching
            against whichever Property field you point it at (normally Bedrooms). The pair whose
            Property side is a price/currency field uses the grace percentage above. Every other
            pair is saved for reference. Changes apply to the next match — nothing needs a deploy.
          </p>
        </>
      )}
    </div>
  );
}
