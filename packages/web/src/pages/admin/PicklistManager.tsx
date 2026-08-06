import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, ListTree, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Skeleton, Spinner, Toggle } from '../../components/ui';

interface Option {
  value: string;
  label: string;
  color: string | null;
  isActive: boolean;
  isDefault: boolean;
}

const SWATCHES = ['#64748b', '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6',
  '#0ea5e9', '#6366f1', '#a855f7', '#ec4899'];

export default function PicklistManager(): JSX.Element {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>('lead_status');
  const [options, setOptions] = useState<Option[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const { data: picklists, isLoading } = useQuery({
    queryKey: ['picklists'],
    queryFn: () => api.picklists(),
  });

  useEffect(() => {
    const values = picklists?.[selected];
    if (values) {
      setOptions(values.map((v) => ({
        value: v.value, label: v.label, color: v.color,
        isActive: true, isDefault: false,
      })));
      setDirty(false);
    }
  }, [picklists, selected]);

  const names = Object.keys(picklists ?? {})
    .filter((n) => n.includes(search.toLowerCase().replace(/\s/g, '_')))
    .sort();

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.savePicklistValues(selected, options);
      toast.success('Dropdown saved', `${options.length} options in ${selected.replace(/_/g, ' ')}`);
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['picklists'] });
      void queryClient.invalidateQueries({ queryKey: ['module'] });
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const update = (index: number, patch: Partial<Option>): void => {
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
    setDirty(true);
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Dropdowns</h1>
        <p className="text-sm text-slate-500">
          Every dropdown in the CRM. Changing an option updates it everywhere the option set is used.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="card h-fit overflow-hidden">
          <div className="border-b border-slate-100 p-2 dark:border-slate-800">
            <input
              className="input py-1.5 text-sm"
              placeholder="Search dropdowns…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-[32rem] overflow-y-auto p-1.5">
            {isLoading ? (
              <div className="space-y-1">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
            ) : names.map((name) => (
              <button
                key={name}
                onClick={() => setSelected(name)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm capitalize transition-colors',
                  selected === name
                    ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                <span className="truncate">{name.replace(/_/g, ' ')}</span>
                <span className="shrink-0 text-2xs text-slate-400 tnum">{picklists?.[name]?.length ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <ListTree className="h-4 w-4 text-slate-400" />
            <p className="text-sm font-medium capitalize">{selected.replace(/_/g, ' ')}</p>
            <span className="text-2xs text-slate-400 tnum">{options.length} options</span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => {
                  setOptions([...options, { value: '', label: '', color: SWATCHES[options.length % SWATCHES.length], isActive: true, isDefault: false }]);
                  setDirty(true);
                }}
                className="btn-secondary btn-sm"
              >
                <Plus className="h-3.5 w-3.5" /> Add option
              </button>
              <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm">
                {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
              </button>
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2 p-2.5">
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300" />

                <input
                  className="input w-40 py-1.5 text-sm"
                  placeholder="Label"
                  value={option.label}
                  onChange={(e) => {
                    const label = e.target.value;
                    update(index, { label, ...(option.value ? {} : { value: label }) });
                  }}
                />

                <input
                  className="input w-40 py-1.5 font-mono text-xs"
                  placeholder="Stored value"
                  value={option.value}
                  onChange={(e) => update(index, { value: e.target.value })}
                />

                <div className="flex items-center gap-1">
                  {SWATCHES.map((c) => (
                    <button
                      key={c}
                      onClick={() => update(index, { color: c })}
                      className={cn(
                        'h-4 w-4 rounded-full transition-transform hover:scale-125',
                        option.color === c && 'ring-2 ring-slate-400 ring-offset-1 dark:ring-offset-slate-900',
                      )}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                </div>

                <Badge color={option.color} className="ml-1 shrink-0">
                  {option.label || 'Preview'}
                </Badge>

                <div className="ml-auto flex shrink-0 items-center gap-3">
                  <Toggle
                    checked={option.isActive}
                    onChange={(v) => update(index, { isActive: v })}
                    label="Active"
                  />
                  <button
                    onClick={() => { setOptions(options.filter((_, i) => i !== index)); setDirty(true); }}
                    className="text-slate-300 hover:text-red-500"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {options.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No options yet</p>
          )}

          <p className="border-t border-slate-100 px-4 py-2 text-2xs text-slate-400 dark:border-slate-800">
            Removing an option deactivates it rather than deleting it, so existing records keep their value.
          </p>
        </div>
      </div>
    </div>
  );
}
