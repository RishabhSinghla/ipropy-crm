import type { JSX } from 'react';
/**
 * Layout Designer — what a record page looks like, as data.
 *
 * Record presentation and the property-capture panel are editable here rather
 * than hard-coded:
 *
 *   * the sections and the fields inside them (drag, plus add/rename/reorder/delete);
 *   * the summary chips in the record header;
 *   * which tab a record opens on.
 *   * which quick-create fields stay visible at the gate, plus voice/GPS mode.
 *
 * Saving marks the layout as customised, which stops `db:seed` rewriting it on
 * the next schema change — see seed/helpers.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown, ChevronUp, GripVertical, Plus, Save, Trash2, X,
} from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Select, Skeleton, Spinner } from '../../components/ui';

interface LayoutBlock {
  key: string;
  label: string;
  columns: number;
  collapsed?: boolean;
  fields: string[];
}

interface DesignerConfig {
  blocks: LayoutBlock[];
  headerFields: string[];
  defaultTab: string;
  showRecordNumber?: boolean;
  tabs?: DetailTabConfig[];
  capture?: CapturePanelConfig;
}

interface DetailTabConfig {
  key: string;
  label: string;
  icon?: string;
}

interface CapturePanelConfig {
  primaryFieldCount: number;
  gpsEnabled: boolean;
}

const DEFAULT_CAPTURE_PANEL: CapturePanelConfig = {
  primaryFieldCount: 4,
  gpsEnabled: true,
};

/** Tabs the record page can open on. Relation tabs are appended per module. */
const BASE_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'files', label: 'Files' },
];

export default function LayoutDesigner(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [moduleName, setModuleName] = useState(modules[0]?.name ?? 'leads');
  const [layoutType, setLayoutType] = useState<'detail' | 'edit' | 'quick_create'>('detail');
  const [blocks, setBlocks] = useState<LayoutBlock[]>([]);
  const [headerFields, setHeaderFields] = useState<string[]>([]);
  const [defaultTab, setDefaultTab] = useState('overview');
  const [showRecordNumber, setShowRecordNumber] = useState(false);
  const [detailTabs, setDetailTabs] = useState<DetailTabConfig[]>([]);
  const [capturePanel, setCapturePanel] = useState<CapturePanelConfig>(DEFAULT_CAPTURE_PANEL);
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
    ) as { id: string; config: Partial<DesignerConfig> } | undefined;

    if (layout) {
      setLayoutId(layout.id);
      setBlocks(layout.config.blocks ?? []);
      setHeaderFields(layout.config.headerFields ?? []);
      setDefaultTab(layout.config.defaultTab ?? 'overview');
      setShowRecordNumber(layout.config.showRecordNumber ?? false);
      setDetailTabs(layout.config.tabs ?? []);
      setCapturePanel({ ...DEFAULT_CAPTURE_PANEL, ...(layout.config.capture ?? {}) });
    } else if (meta) {
      // Fall back to the module's block structure so there's always something
      // to edit — saving then creates the layout rather than refusing.
      setLayoutId(null);
      setBlocks(meta.blocks.map((b) => ({
        key: b.name, label: b.label, columns: b.columns,
        collapsed: b.isCollapsed, fields: b.fields.map((f) => f.name),
      })));
      setHeaderFields(meta.blocks[0]?.fields.slice(0, 4).map((f) => f.name) ?? []);
      setDefaultTab('overview');
      setShowRecordNumber(false);
      setDetailTabs([]);
      setCapturePanel(DEFAULT_CAPTURE_PANEL);
    }
    setDirty(false);
  }, [layouts, layoutType, meta?.id]);

  const fieldMap = useMemo(
    () => new Map((meta?.fields ?? []).map((f) => [f.name, f])),
    [meta?.fields],
  );

  const placeable = (meta?.fields ?? []).filter((f) => f.isActive && f.displayType !== 'hidden');
  const usedFields = new Set(blocks.flatMap((b) => b.fields));
  const availableFields = placeable.filter((f) => !usedFields.has(f.name));

  const availableTabs = [
    ...BASE_TABS,
    ...(meta?.relations ?? []).map((r) => ({ value: `rel:${r.name}`, label: r.label })),
    ...(moduleName === 'leads' ? [{ value: 'calls', label: 'Calls' }] : []),
  ];
  const detailTabOptions = detailTabs.length
    ? detailTabs
    : availableTabs.map((option) => ({ key: option.value, label: option.label }));
  const tabOptions = detailTabOptions.map((tab) => ({ value: tab.key, label: tab.label }));

  const touch = (): void => setDirty(true);

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
    touch();
  };

  const moveSection = (index: number, delta: number): void => {
    setBlocks((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    touch();
  };

  /**
   * A section is one thing, not one per layout.
   *
   * Adding and deleting used to happen only in this component's own state, so a
   * section created here never appeared in the Section dropdown on Modules &
   * Fields — no field could ever be put in it — and one deleted here stayed on
   * that page for ever, showing as an empty block nobody could remove. Both
   * halves now go through the module's real sections, and this layout follows.
   */
  const blockIdFor = (key: string): string | undefined =>
    (meta?.blocks ?? []).find((b) => b.name === key)?.id;

  const addSection = async (): Promise<void> => {
    const label = window.prompt('Name the new section');
    if (!label?.trim()) return;
    // Keyed on time rather than the label so renaming a section never collides
    // with another one, and so two "New section"s can coexist while being named.
    const key = `section_${Date.now().toString(36)}`;
    try {
      await api.createBlock(moduleName, { name: key, label: label.trim() });
    } catch (err) {
      toast.error('Could not add the section', (err as Error).message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['module', moduleName] });
    setBlocks((prev) => [...prev, { key, label: label.trim(), columns: 2, fields: [] }]);
    touch();
  };

  const renameSection = async (key: string, label: string): Promise<void> => {
    const id = blockIdFor(key);
    const current = (meta?.blocks ?? []).find((b) => b.name === key)?.label;
    if (!id || !label.trim() || label.trim() === current) return;
    try {
      await api.updateBlock(id, { label: label.trim() });
      await queryClient.invalidateQueries({ queryKey: ['module', moduleName] });
    } catch (err) {
      toast.error('Could not rename the section', (err as Error).message);
    }
  };

  const removeSection = async (key: string): Promise<void> => {
    const id = blockIdFor(key);
    // No matching section means this one exists only in this layout — an older
    // layout naming a section that has since gone. Dropping it locally is the
    // whole job.
    if (id) {
      try {
        await api.deleteBlock(id);
      } catch (err) {
        toast.error('Could not delete the section', (err as Error).message);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['module', moduleName] });
      toast.success('Section deleted', 'Gone from every layout and from Modules & Fields.');
    }
    setBlocks((prev) => prev.filter((b) => b.key !== key));
    touch();
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const existing = (layouts ?? []).find((l) => (l as { id: string }).id === layoutId) as
        { config: Record<string, unknown> } | undefined;
      const config = {
        ...(existing?.config ?? {}),
        blocks,
        // Only the detail view has a header strip and tabs; keeping them off the
        // edit/quick-create configs avoids writing keys nothing will read.
        ...(layoutType === 'detail'
          ? { headerFields, defaultTab, showRecordNumber, tabs: detailTabOptions }
          : {}),
        ...(layoutType === 'quick_create' && moduleName === 'properties'
          ? { capture: capturePanel }
          : {}),
      };

      if (layoutId) {
        await api.saveLayout(layoutId, { config });
      } else {
        const created = await api.createLayout(moduleName, {
          name: `Default ${layoutType.replace('_', ' ')} layout`,
          type: layoutType,
          isDefault: true,
          config,
        });
        setLayoutId(created.id);
      }

      toast.success('Layout saved');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['layouts', moduleName] });
      void queryClient.invalidateQueries({ queryKey: ['layout', moduleName] });
      // The record page reads header fields and the default tab off the module
      // describe, so that has to be refetched too or the change won't show.
      void queryClient.invalidateQueries({ queryKey: ['module', moduleName] });
    } catch (err) {
      toast.error('Could not save the layout', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Layout Designer</h1>
          <p className="text-sm text-muted">
            Arrange the sections, fields, header chips and opening tab of a record page.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
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
          <div className="space-y-3">
            {layoutType === 'quick_create' && moduleName === 'properties' && (
              <div className="card p-4">
                <div className="mb-3">
                  <p className="text-sm font-semibold">Property capture panel</p>
                  <p className="text-xs text-muted">
                    Drives the Site visit screen. The field order below is the order it asks for them; choose how many stay visible before "More details".
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label>
                    <span className="label">Fast fields shown</span>
                    <Select
                      value={String(capturePanel.primaryFieldCount)}
                      onChange={(value) => {
                        setCapturePanel((prev) => ({ ...prev, primaryFieldCount: Number(value) }));
                        touch();
                      }}
                      options={Array.from({ length: Math.max(1, Math.min(12, placeable.length)) }, (_, i) => ({
                        value: String(i + 1), label: String(i + 1),
                      }))}
                    />
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-sm dark:border-slate-700">
                    <input
                      type="checkbox"
                      checked={capturePanel.gpsEnabled}
                      onChange={(event) => {
                        setCapturePanel((prev) => ({ ...prev, gpsEnabled: event.target.checked }));
                        touch();
                      }}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    Offer optional GPS
                  </label>
                </div>
              </div>
            )}

            {layoutType === 'detail' && (
              <HeaderStripEditor
                value={headerFields}
                options={placeable.map((f) => ({ value: f.name, label: f.label }))}
                defaultTab={defaultTab}
                tabOptions={tabOptions}
                tabs={detailTabOptions}
                availableTabs={availableTabs}
                showRecordNumber={showRecordNumber}
                onChange={(next) => { setHeaderFields(next); touch(); }}
                onShowRecordNumberChange={(next) => { setShowRecordNumber(next); touch(); }}
                onDefaultTabChange={(next) => { setDefaultTab(next); touch(); }}
                onTabsChange={(next) => {
                  setDetailTabs(next);
                  if (!next.some((item) => item.key === defaultTab)) setDefaultTab(next[0]?.key ?? 'overview');
                  touch();
                }}
              />
            )}

            {blocks.map((block, index) => (
              <div key={block.key} className="card overflow-hidden">
                <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
                  <div className="flex shrink-0 flex-col">
                    <button
                      onClick={() => moveSection(index, -1)}
                      disabled={index === 0}
                      className="btn-ghost p-0.5 disabled:opacity-25"
                      title="Move section up"
                      aria-label={`Move ${block.label} up`}
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => moveSection(index, 1)}
                      disabled={index === blocks.length - 1}
                      className="btn-ghost p-0.5 disabled:opacity-25"
                      title="Move section down"
                      aria-label={`Move ${block.label} down`}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>

                  <input
                    className="min-w-0 flex-1 rounded border-0 bg-transparent p-0 text-sm font-medium outline-none focus:ring-0"
                    value={block.label}
                    aria-label="Section name"
                    onChange={(e) => {
                      setBlocks((prev) => prev.map((b) => b.key === block.key ? { ...b, label: e.target.value } : b));
                      touch();
                    }}
                    // The section is renamed for the module, not just for this
                    // layout — otherwise the heading here and the one on
                    // Modules & Fields drift apart and neither is wrong.
                    onBlur={() => void renameSection(block.key, block.label)}
                  />

                  <label className="flex shrink-0 items-center gap-1 text-2xs text-muted">
                    <input
                      type="checkbox"
                      className="h-3 w-3 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      checked={Boolean(block.collapsed)}
                      onChange={(e) => {
                        setBlocks((prev) => prev.map((b) => b.key === block.key ? { ...b, collapsed: e.target.checked } : b));
                        touch();
                      }}
                    />
                    Collapsed
                  </label>

                  <Select
                    value={String(block.columns)}
                    onChange={(v) => {
                      setBlocks((prev) => prev.map((b) => b.key === block.key ? { ...b, columns: Number(v) } : b));
                      touch();
                    }}
                    options={[1, 2, 3].map((n) => ({ value: String(n), label: `${n} column${n > 1 ? 's' : ''}` }))}
                    className="w-28 shrink-0 py-1 text-xs"
                  />

                  <button
                    onClick={() => void removeSection(block.key)}
                    className="btn-ghost shrink-0 p-1 text-slate-400 hover:text-red-500"
                    title="Delete this section everywhere — move its fields out first"
                    aria-label={`Delete section ${block.label}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
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
                    {block.fields.map((fieldName, fieldIndex) => {
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
                              move(dragging.block, dragging.field, block.key, fieldIndex);
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
                              touch();
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

            <button onClick={() => void addSection()} className="btn-secondary btn-sm">
              <Plus className="h-3.5 w-3.5" /> Add section
            </button>
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
    </div>
  );
}

/**
 * The strip of key-value chips beside a record's name, and the tab it opens on.
 *
 * Both were fixed in code — the header always showed the first four fields of
 * the first section, and every record opened on Overview. On a lead the useful
 * four are not the first four, and a desk that lives in the timeline wants to
 * land there.
 */
function HeaderStripEditor({
  value, options, defaultTab, tabOptions, tabs, availableTabs, showRecordNumber,
  onChange, onDefaultTabChange, onTabsChange, onShowRecordNumberChange,
}: {
  value: string[];
  options: { value: string; label: string }[];
  defaultTab: string;
  tabOptions: { value: string; label: string }[];
  tabs: DetailTabConfig[];
  availableTabs: { value: string; label: string }[];
  showRecordNumber: boolean;
  onChange: (next: string[]) => void;
  onDefaultTabChange: (next: string) => void;
  onTabsChange: (next: DetailTabConfig[]) => void;
  onShowRecordNumberChange: (next: boolean) => void;
}): JSX.Element {
  const labelOf = (name: string): string => options.find((o) => o.value === name)?.label ?? name;
  const unused = options.filter((o) => !value.includes(o.value));
  const unusedTabs = availableTabs.filter((option) => !tabs.some((tab) => tab.key === option.value));

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
        <p className="text-sm font-medium">Record header</p>
      </div>

      <div className="space-y-3 p-3">
        <div>
          <label className="label">Summary fields</label>
          <p className="mb-1.5 text-2xs text-muted">
            Shown as chips beside the record name. Order is the order they appear in.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {value.map((name, i) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
              >
                <button
                  onClick={() => {
                    const next = [...value];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    onChange(next);
                  }}
                  disabled={i === 0}
                  className="text-slate-300 hover:text-slate-500 disabled:opacity-25"
                  aria-label={`Move ${labelOf(name)} left`}
                >
                  <ChevronUp className="h-3 w-3 -rotate-90" />
                </button>
                <span className="font-medium">{labelOf(name)}</span>
                <button
                  onClick={() => onChange(value.filter((v) => v !== name))}
                  className="text-slate-300 hover:text-red-500"
                  aria-label={`Remove ${labelOf(name)} from the header`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {value.length === 0 && (
              <span className="text-xs text-muted">No summary fields — only the name and owner will show.</span>
            )}
          </div>

          {unused.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <Select
                value=""
                placeholder="Add a field…"
                onChange={(v) => v && onChange([...value, v])}
                options={unused}
                className="w-56 py-1.5 text-xs"
              />
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showRecordNumber}
              onChange={(event) => onShowRecordNumberChange(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Show the record number (LD-00003) beside the name
          </label>
          <p className="mt-1 text-2xs text-muted">
            Off by default. The number is still on the record and still searchable — this
            only controls whether it takes up space in the header.
          </p>
        </div>

        <div>
          <label className="label">Detail tabs</label>
          <p className="mb-1.5 text-2xs text-muted">
            Rename, reorder, hide and restore Overview, Timeline, Calls, Files and related sections.
          </p>
          <div className="space-y-1.5">
            {tabs.map((tab, index) => (
              <div key={tab.key} className="flex items-center gap-1.5 rounded-lg border border-slate-200 p-1.5 dark:border-slate-700">
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...tabs];
                      [next[index - 1], next[index]] = [next[index], next[index - 1]];
                      onTabsChange(next);
                    }}
                    disabled={index === 0}
                    className="text-slate-300 hover:text-slate-500 disabled:opacity-25"
                    aria-label={`Move ${tab.label} up`}
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...tabs];
                      [next[index], next[index + 1]] = [next[index + 1], next[index]];
                      onTabsChange(next);
                    }}
                    disabled={index === tabs.length - 1}
                    className="text-slate-300 hover:text-slate-500 disabled:opacity-25"
                    aria-label={`Move ${tab.label} down`}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </div>
                <input
                  className="input min-w-0 flex-1 py-1 text-xs"
                  value={tab.label}
                  aria-label={`Name for ${tab.key} tab`}
                  onChange={(event) => onTabsChange(tabs.map((item) => (
                    item.key === tab.key ? { ...item, label: event.target.value } : item
                  )))}
                />
                <span className="hidden shrink-0 font-mono text-2xs text-muted sm:inline">{tab.key}</span>
                <button
                  type="button"
                  className="btn-ghost p-1 text-slate-400 hover:text-red-500"
                  onClick={() => onTabsChange(tabs.filter((item) => item.key !== tab.key))}
                  disabled={tabs.length === 1}
                  aria-label={`Hide ${tab.label} tab`}
                  title={tabs.length === 1 ? 'A record needs at least one tab' : 'Hide tab'}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          {unusedTabs.length > 0 && (
            <Select
              value=""
              placeholder="Restore a hidden tab…"
              onChange={(key) => {
                const option = unusedTabs.find((item) => item.value === key);
                if (option) onTabsChange([...tabs, { key: option.value, label: option.label }]);
              }}
              options={unusedTabs}
              className="mt-2 w-56 py-1.5 text-xs"
            />
          )}
          {tabs.length === 0 && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              At least one tab is recommended. Restore one before saving to keep the record body usable.
            </p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="default-tab">Opens on</label>
          <Select
            value={defaultTab}
            onChange={onDefaultTabChange}
            options={tabOptions}
            disabled={tabOptions.length === 0}
            className="w-56 py-1.5 text-sm"
          />
          <p className="mt-1 text-2xs text-muted">
            The tab shown when someone opens a record of this module.
          </p>
        </div>
      </div>
    </div>
  );
}
