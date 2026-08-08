import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, LayoutTemplate, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, EmptyState, Select, Skeleton, Spinner } from '../../components/ui';

interface LayoutBlock {
  key: string;
  label: string;
  columns: number;
  collapsed?: boolean;
  fields: string[];
}

export default function LayoutDesigner(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [moduleName, setModuleName] = useState(modules[0]?.name ?? 'leads');
  const [layoutType, setLayoutType] = useState<'detail' | 'edit' | 'quick_create'>('detail');
  const [blocks, setBlocks] = useState<LayoutBlock[]>([]);
  const [layoutId, setLayoutId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<{ block: string; field: string } | null>(null);

  const { data: meta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName),
  });

  const { data: layouts, isLoading } = useQuery({
    queryKey: ['layouts', moduleName],
    queryFn: () => api.layouts(moduleName),
  });

  useEffect(() => {
    const layout = (layouts ?? []).find(
      (l) => (l as { type: string; is_default: boolean }).type === layoutType
        && (l as { is_default: boolean }).is_default,
    ) as { id: string; config: { blocks?: LayoutBlock[] } } | undefined;

    if (layout) {
      setLayoutId(layout.id);
      setBlocks(layout.config.blocks ?? []);
    } else if (meta) {
      // Fall back to the module's block structure so there's always something to edit.
      setLayoutId(null);
      setBlocks(meta.blocks.map((b) => ({
        key: b.name, label: b.label, columns: b.columns,
        collapsed: b.isCollapsed, fields: b.fields.map((f) => f.name),
      })));
    }
    setDirty(false);
  }, [layouts, layoutType, meta?.id]);

  const fieldMap = new Map((meta?.fields ?? []).map((f) => [f.name, f]));
  const usedFields = new Set(blocks.flatMap((b) => b.fields));
  const availableFields = (meta?.fields ?? []).filter(
    (f) => f.isActive && f.displayType !== 'hidden' && !usedFields.has(f.name),
  );

  const move = (fromBlock: string, field: string, toBlock: string, toIndex: number): void => {
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b, fields: [...b.fields] }));
      const from = next.find((b) => b.key === fromBlock);
      const to = next.find((b) => b.key === toBlock);
      if (!to) return prev;
      if (from) from.fields = from.fields.filter((f) => f !== field);
      to.fields.splice(toIndex, 0, field);
      return next;
    });
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!layoutId) {
      toast.error('No saved layout', 'This module has no stored layout to update yet.');
      return;
    }
    setSaving(true);
    try {
      const existing = (layouts ?? []).find((l) => (l as { id: string }).id === layoutId) as
        { config: Record<string, unknown> } | undefined;
      await api.saveLayout(layoutId, {
        config: { ...(existing?.config ?? {}), blocks },
      });
      toast.success('Layout saved');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['layouts', moduleName] });
      void queryClient.invalidateQueries({ queryKey: ['layout', moduleName] });
    } catch (err) {
      toast.error('Could not save the layout', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Layout Designer</h1>
          <p className="text-sm text-muted">
            Drag fields between sections to change how records are displayed and edited.
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Select
            value={moduleName}
            onChange={setModuleName}
            options={modules.filter((m) => m.isEntity).map((m) => ({ value: m.name, label: m.label }))}
            className="w-44 py-1.5 text-sm"
          />
          <Select
            value={layoutType}
            onChange={(v) => setLayoutType(v as typeof layoutType)}
            options={[
              { value: 'detail', label: 'Detail view' },
              { value: 'edit', label: 'Edit form' },
              { value: 'quick_create', label: 'Quick create' },
            ]}
            className="w-36 py-1.5 text-sm"
          />
          <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm">
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
        </div>
      </div>

      {isLoading || !meta ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
          {/* Blocks */}
          <div className="space-y-3">
            {blocks.map((block) => (
              <div key={block.key} className="card overflow-hidden">
                <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/40">
                  <input
                    className="flex-1 border-0 bg-transparent p-0 text-sm font-medium outline-none"
                    value={block.label}
                    onChange={(e) => {
                      setBlocks((prev) => prev.map((b) => b.key === block.key ? { ...b, label: e.target.value } : b));
                      setDirty(true);
                    }}
                  />
                  <Select
                    value={String(block.columns)}
                    onChange={(v) => {
                      setBlocks((prev) => prev.map((b) => b.key === block.key ? { ...b, columns: Number(v) } : b));
                      setDirty(true);
                    }}
                    options={[1, 2, 3].map((n) => ({ value: String(n), label: `${n} column${n > 1 ? 's' : ''}` }))}
                    className="w-28 py-1 text-xs"
                  />
                </div>

                <div
                  className="min-h-[3rem] p-2"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging) { move(dragging.block, dragging.field, block.key, block.fields.length); setDragging(null); }
                  }}
                >
                  <div className={cn(
                    'grid gap-1.5',
                    block.columns === 1 ? 'grid-cols-1' : block.columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
                  )}>
                    {block.fields.map((fieldName, index) => {
                      const field = fieldMap.get(fieldName);
                      return (
                        <div
                          key={fieldName}
                          draggable
                          onDragStart={() => setDragging({ block: block.key, field: fieldName })}
                          onDragEnd={() => setDragging(null)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            if (dragging && dragging.field !== fieldName) {
                              move(dragging.block, dragging.field, block.key, index);
                              setDragging(null);
                            }
                          }}
                          className={cn(
                            'flex cursor-grab items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs transition-all active:cursor-grabbing dark:border-slate-700 dark:bg-slate-800',
                            dragging?.field === fieldName && 'opacity-40',
                          )}
                        >
                          <GripVertical className="h-3 w-3 shrink-0 text-slate-300" />
                          <span className="min-w-0 flex-1 truncate font-medium">{field?.label ?? fieldName}</span>
                          {field?.isMandatory && <span className="text-negative">*</span>}
                          <button
                            onClick={() => {
                              setBlocks((prev) => prev.map((b) =>
                                b.key === block.key ? { ...b, fields: b.fields.filter((f) => f !== fieldName) } : b));
                              setDirty(true);
                            }}
                            className="shrink-0 text-slate-300 hover:text-red-500"
                            title="Remove from layout"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {block.fields.length === 0 && (
                    <p className="py-3 text-center text-xs text-muted">Drop fields here</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Available fields */}
          <div className="card h-fit overflow-hidden">
            <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
              <p className="text-xs font-medium text-muted">
                Unplaced fields ({availableFields.length})
              </p>
            </div>
            <div className="max-h-[30rem] space-y-1 overflow-y-auto p-2">
              {availableFields.map((field) => (
                <div
                  key={field.name}
                  draggable
                  onDragStart={() => setDragging({ block: '', field: field.name })}
                  onDragEnd={() => setDragging(null)}
                  className="flex cursor-grab items-center gap-1.5 rounded-lg border border-dashed border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700"
                >
                  <GripVertical className="h-3 w-3 shrink-0 text-slate-300" />
                  <span className="min-w-0 flex-1 truncate">{field.label}</span>
                  <Badge>{field.uitype}</Badge>
                </div>
              ))}
              {availableFields.length === 0 && (
                <p className="py-6 text-center text-xs text-muted">Every field is placed</p>
              )}
            </div>
          </div>
        </div>
      )}

      {!layoutId && !isLoading && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          This module has no saved {layoutType.replace('_', ' ')} layout yet — you're seeing its default
          block structure. Saving requires a stored layout; re-run the seed to create one.
        </p>
      )}
    </div>
  );
}
