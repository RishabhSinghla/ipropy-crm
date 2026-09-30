/**
 * Layout Designer — what a record looks like, as data.
 *
 * Three screens are arranged here, and the picker at the top names them by the
 * screen they change:
 *
 *   * **Split view** — the queue card, the facts pinned at the top of the
 *     right pane, the record's tabs, and the field sections under the pinned
 *     facts (the four-pane layout of 30 September 2026). This is the screen the team works in all day, and
 *     since 29 September 2026 every control for it is one the split view
 *     actually reads (`lib/splitViewLayout.ts`). Before that, the header's key
 *     fields, the tabs and "opens on" were saved and ignored.
 *   * **New record form** — the + New dialog, Capture on site and the phone
 *     app's record screen.
 *   * **Full page form** — Inventories only.
 *
 * Saving marks the layout as customised, which stops `db:seed` rewriting it on
 * the next schema change — see seed/helpers.ts.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown, ChevronUp, GripVertical, MoreHorizontal, Plus, RefreshCw, RotateCcw, Save, Trash2,
} from 'lucide-react';
import type { RecordEnvelope } from '@ipropy/shared';
import { assignmentField, byLabel, pipelineFieldOf } from '../../lib/fields';
import { queueCardFields } from '../../lib/queueCard';
import { allSplitTabs, CALL_LOG_ROW, heroFieldNames, OWNER_ROW, rightPaneRowNames, splitTabsFor, type SplitTab } from '../../lib/splitViewLayout';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Dropdown, DropdownItem, Modal, Select, Skeleton, Spinner } from '../../components/ui';
import { HeaderFactsPreview, OrderedFieldList, Preview, QueueCardPreview, TabsEditor, Zone } from './SplitViewZones';

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
  headerFieldsCustomized?: boolean;
  queueFields?: string[];
  heroFields?: string[];
  splitTabs?: SplitTab[];
  rightPane?: string[];
  capture?: CapturePanelConfig;
}

interface CapturePanelConfig {
  primaryFieldCount: number;
  gpsEnabled: boolean;
}

const DEFAULT_CAPTURE_PANEL: CapturePanelConfig = {
  primaryFieldCount: 4,
  gpsEnabled: true,
};

type LayoutType = 'detail' | 'edit' | 'quick_create';

/** Named after the screen each one changes, not after the database's word for it. */
const SCREEN_LABEL: Record<LayoutType, string> = {
  detail: 'Split view',
  quick_create: 'New record form',
  edit: 'Full page form',
};

/** A record's value as a person reads it, for the previews. */
function readValue(record: RecordEnvelope | null | undefined, name: string): string {
  if (!record) return '';
  const shown = record.display?.[name];
  if (shown) return shown;
  const raw = record.values[name];
  if (Array.isArray(raw)) return raw.join(', ');
  return raw === null || raw === undefined ? '' : String(raw);
}

export default function LayoutDesigner(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [moduleName, setModuleName] = useState(modules[0]?.name ?? 'leads');
  const [layoutType, setLayoutType] = useState<LayoutType>('detail');
  /*
    Switching to a module that has no full-page form must not leave the picker
    on an option it no longer offers — the Select would show blank and the next
    save would write the layout you could not see.
  */
  useEffect(() => {
    if (layoutType === 'edit' && moduleName !== 'properties') setLayoutType('detail');
  }, [moduleName, layoutType]);
  const [blocks, setBlocks] = useState<LayoutBlock[]>([]);
  const [newSection, setNewSection] = useState(false);
  /** The WhatsApp chat header's facts — the old "header fields" key. */
  const [headerFields, setHeaderFields] = useState<string[]>([]);
  const [headerTouched, setHeaderTouched] = useState(false);
  /** Undefined means "not chosen": the split view shows what it ships with. */
  const [queueFields, setQueueFields] = useState<string[] | undefined>();
  const [heroFields, setHeroFields] = useState<string[] | undefined>();
  const [splitTabs, setSplitTabs] = useState<SplitTab[] | undefined>();
  const [rightPane, setRightPane] = useState<string[] | undefined>();
  const [capturePanel, setCapturePanel] = useState<CapturePanelConfig>(DEFAULT_CAPTURE_PANEL);
  const [layoutId, setLayoutId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<{ block: string; field: string } | null>(null);
  /** Filters the Unplaced list. On a module with sixty fields, scrolling to find one is the whole problem. */
  const [search, setSearch] = useState('');
  /** Which record the previews are drawn from — "Show another" steps through the list. */
  const [sampleAt, setSampleAt] = useState(1);
  /** Reloads the saved layout, throwing away what has not been saved. */
  const [reloadKey, setReloadKey] = useState(0);

  /*
    Work in progress is not lost to a stray click. Leaving the page, or moving
    to another module or screen, asks first while there is something unsaved.
  */
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const leaveIfSaved = (go: () => void): void => {
    if (!dirty || window.confirm('You have changes that are not saved. Leave them?')) go();
  };

  const { data: meta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName),
  });

  const { data: layouts, isLoading } = useQuery({
    queryKey: ['layouts', moduleName],
    queryFn: () => api.layouts(moduleName),
  });

  const { data: sample } = useQuery({
    queryKey: ['layout-sample', moduleName, sampleAt],
    queryFn: async () => {
      const page = await api.list(moduleName, { page: sampleAt, pageSize: 1 });
      const id = page.rows[0]?.id;
      return id ? api.record(moduleName, id) : null;
    },
    enabled: layoutType === 'detail',
  });
  const sampleOf = (name: string): string => readValue(sample, name);

  useEffect(() => {
    const layout = (layouts ?? []).find(
      (l) => (l as { type: string; is_default: boolean }).type === layoutType
        && (l as { is_default: boolean }).is_default,
    ) as { id: string; config: Partial<DesignerConfig> } | undefined;

    if (layout) {
      setLayoutId(layout.id);
      setBlocks(layout.config.blocks ?? []);
      const saved = layout.config.headerFields ?? [];
      const implicit = meta && !layout.config.headerFieldsCustomized
        ? [
          pipelineFieldOf(meta),
          meta.fields.find((field) => field.config.picklist === 'lost_reason'),
          meta.fields.find((field) => String(field.config.picklist ?? '').endsWith('_source')),
          meta.fields.find((field) => field.columnName === 'next_followup_at'),
          meta.fields.find((field) => field.config.picklist === 'contact_type'),
        ].filter((field): field is NonNullable<typeof field> => Boolean(field)).map((field) => field.name)
        : [];
      setHeaderFields([...new Set([...saved, ...implicit])]);
      setQueueFields(layout.config.queueFields);
      setHeroFields(layout.config.heroFields);
      setRightPane(layout.config.rightPane);
      setSplitTabs(layout.config.splitTabs ? splitTabsFor(moduleName, layout.config.splitTabs) : undefined);
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
      setQueueFields(undefined);
      setHeroFields(undefined);
      setSplitTabs(undefined);
      setCapturePanel(DEFAULT_CAPTURE_PANEL);
    }
    setDirty(false);
    setHeaderTouched(false);
  }, [layouts, layoutType, meta?.id, reloadKey]);

  const fieldMap = useMemo(
    () => new Map((meta?.fields ?? []).map((f) => [f.name, f])),
    [meta?.fields],
  );

  const placeable = (meta?.fields ?? []).filter((f) => f.isActive && f.displayType !== 'hidden');
  const usedFields = new Set(blocks.flatMap((b) => b.fields));
  // A–Z, because this is a list to find one name in, and metadata order is
  // not an order anybody can navigate.
  const availableFields = placeable
    .filter((f) => !usedFields.has(f.name))
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const unplaced = search.trim()
    ? availableFields.filter((f) => f.label.toLowerCase().includes(search.trim().toLowerCase()))
    : availableFields;

  const fieldOptions = byLabel(placeable).map((f) => ({ value: f.name, label: f.label }));

  /*
    What the split view shows when nothing has been chosen — the same answers
    `useRecordPanes` reaches, so the designer opens on the screen as it is.
  */
  const followUpName = meta?.fields.find((f) => f.columnName === 'next_followup_at')?.name
    ?? meta?.fields.find((f) => /next.*follow.*up/i.test(f.name))?.name;
  const statusName = meta ? pipelineFieldOf(meta)?.name : undefined;
  const queueShown = queueFields ?? (() => {
    const card = meta ? queueCardFields(meta.fields) : null;
    return card
      ? [card.bedrooms, card.portion, card.category, card.locality]
        .filter((field): field is NonNullable<typeof field> => Boolean(field)).map((field) => field.name)
      : [];
  })();
  const heroShown = heroFieldNames(heroFields, followUpName, statusName);
  /*
    The right pane's top rows — every one of them, owner and call log
    included, the owner's ask of 3 October 2026. `useRecordPanes` reads the
    same function, so the preview and the pane cannot disagree.
  */
  const ownerName = meta ? assignmentField(meta.fields)?.name : undefined;
  const phoneName = meta?.fields.find((f) => f.uitype === 'phone')?.name;
  const rightPaneShown = rightPaneRowNames(
    rightPane, heroShown, ownerName, phoneName,
    new Set(blocks.flatMap((block) => block.fields)),
  );
  const rightPaneOptions = [
    { value: OWNER_ROW, label: 'Assigned to' },
    { value: CALL_LOG_ROW, label: 'Call Log' },
    ...fieldOptions.filter((option) => option.value !== ownerName),
  ];
  const rightPaneLabel = (name: string): string =>
    rightPaneOptions.find((option) => option.value === name)?.label ?? labelOf(name);
  const rightPaneSample = (name: string): string => {
    if (name === CALL_LOG_ROW) return 'the last call\'s outcome';
    return sampleOf(name === OWNER_ROW ? ownerName ?? '' : name);
  };
  const tabsShown = splitTabs ?? allSplitTabs(moduleName);
  const labelOf = (name: string): string => fieldMap.get(name)?.label ?? name;

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

  const addSection = async (label: string): Promise<void> => {
    if (!label.trim()) return;
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
      const config: Record<string, unknown> = {
        ...(existing?.config ?? {}),
        blocks,
        // Only the split view reads these; keeping them off the other two
        // screens avoids writing keys nothing will read.
        ...(layoutType === 'detail'
          ? { headerFields, ...(headerTouched ? { headerFieldsCustomized: true } : {}) }
          : {}),
        ...(layoutType === 'quick_create' && moduleName === 'properties'
          ? { capture: capturePanel }
          : {}),
      };
      /*
        "Back to default" has to reach the database as an absent key, not as
        the default's current value written down — otherwise the day the CRM's
        own default improves, this module keeps the old one for ever.
      */
      if (layoutType === 'detail') {
        for (const [key, chosen] of [['queueFields', queueFields], ['heroFields', heroFields], ['splitTabs', splitTabs], ['rightPane', rightPane]] as const) {
          if (chosen === undefined) delete config[key];
          else config[key] = chosen;
        }
      }

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

      toast.success('Layout saved', layoutType === 'detail' ? 'The split view shows it for everybody now — reload an open list to see it.' : undefined);
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
      {newSection && (
        <NewSectionDialog
          onClose={() => setNewSection(false)}
          onSave={(label) => {
            setNewSection(false);
            void addSection(label);
          }}
        />
      )}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Layout Designer</h1>
          <p className="text-sm text-muted">
            {layoutType === 'detail'
              ? 'Arrange the split view: the queue card, the record’s tabs, and the pinned facts and field sections in the right pane.'
              : layoutType === 'quick_create'
                ? 'Arrange the + New form, Capture on site and the phone app’s record screen.'
                : 'Arrange the Inventories full page form.'}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={moduleName}
            onChange={(next) => leaveIfSaved(() => setModuleName(next))}
            options={modules.filter((m) => m.isEntity).map((m) => ({ value: m.name, label: m.label }))}
            className="w-44 py-1.5 text-sm"
          />
          {/*
            Named after the screen each one changes. "Detail view" and "Quick
            create" were the database's words; nobody could tell from them
            that the first one *is* the split view.

            Only the screens this module actually has: "Full page form" is the
            second half of the split New button, which exists on Inventories
            alone.
          */}
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="group" aria-label="Which screen">
            {(['detail', 'quick_create', ...(moduleName === 'properties' ? ['edit' as const] : [])] as LayoutType[]).map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={layoutType === type}
                onClick={() => leaveIfSaved(() => setLayoutType(type))}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                  layoutType === type ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                {SCREEN_LABEL[type]}
              </button>
            ))}
          </div>
          {dirty && (
            <button type="button" onClick={() => setReloadKey((n) => n + 1)} className="btn-ghost btn-sm" title="Throw away what has not been saved">
              <RotateCcw className="h-3.5 w-3.5" /> Undo changes
            </button>
          )}
          <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary btn-sm">
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {dirty ? 'Save changes' : 'Saved'}
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
                  <p className="text-sm font-semibold">Inventory capture panel</p>
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
              <>
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/50">
                  <span className="text-muted">Previews use</span>
                  <strong className="truncate">{sample?.label ?? '…'}</strong>
                  <button type="button" onClick={() => setSampleAt((n) => n + 1)} className="btn-ghost btn-sm ml-auto text-2xs">
                    <RefreshCw className="h-3 w-3" /> Show another record
                  </button>
                </div>

                <div className="grid gap-3 xl:grid-cols-[18rem_minmax(0,1fr)]">
                  <Zone
                    step={1}
                    title="Left pane — queue card"
                    hint="The line of facts under each name in the list on the left. Name, type, price and follow-up keep their own places."
                    onReset={queueFields ? () => { setQueueFields(undefined); touch(); } : undefined}
                    testId="zone-queue"
                  >
                    <Preview>
                      <QueueCardPreview name={sample?.label ?? 'A record'} values={queueShown.map(sampleOf)} />
                    </Preview>
                    <OrderedFieldList
                      label="Queue card facts"
                      value={queueShown}
                      options={fieldOptions}
                      sampleOf={sampleOf}
                      onChange={(next) => { setQueueFields(next); touch(); }}
                      emptyText="No facts — the card shows only the name."
                    />
                  </Zone>

                  <div className="space-y-3">
                    <Zone
                      step={2}
                      title="Right pane — top rows"
                      hint="Every row at the top of the right pane, under the call deck, in this order — who it is assigned to and the call log included. Add, drag, or take any of them out; each is editable where it stands."
                      onReset={rightPane || heroFields ? () => { setRightPane(undefined); setHeroFields(undefined); touch(); } : undefined}
                      testId="zone-header"
                    >
                      <Preview>
                        <HeaderFactsPreview facts={rightPaneShown.map((name) => ({ label: rightPaneLabel(name), value: rightPaneSample(name) }))} />
                      </Preview>
                      <OrderedFieldList
                        label="Right pane rows"
                        value={rightPaneShown}
                        options={rightPaneOptions}
                        sampleOf={rightPaneSample}
                        onChange={(next) => { setRightPane(next); touch(); }}
                        emptyText="No rows — the right pane starts straight with the sections below."
                      />
                    </Zone>

                    <Zone
                      step={3}
                      title="Middle pane — tabs"
                      hint="Rename, reorder or hide the tabs under the header. The first tab is the one a record opens on."
                      onReset={splitTabs ? () => { setSplitTabs(undefined); touch(); } : undefined}
                      testId="zone-tabs"
                    >
                      <TabsEditor
                        tabs={tabsShown}
                        all={allSplitTabs(moduleName)}
                        onChange={(next) => { setSplitTabs(next); touch(); }}
                      />
                    </Zone>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 px-1 pt-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[11px] font-bold text-white">4</span>
                  <span>
                    <span className="block text-sm font-semibold">Right pane — field sections</span>
                    <span className="block text-2xs text-muted">
                      The sections of fields under the pinned facts, in this order. Drag a field, or use its ⋯ menu to move it.
                      Fields on the right are not on the form yet.
                    </span>
                  </span>
                </div>
              </>
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

                  {/* The split view draws every section open, so offering
                      "Collapsed" there would be a switch that does nothing. */}
                  {layoutType !== 'detail' && (
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
                  )}

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
                    onClick={() => {
                      // A section is the module's, not this layout's: deleting
                      // it removes it from every screen. Its fields are kept
                      // and go back to the list on the right.
                      if (window.confirm(`Delete the section "${block.label}" from every screen? Its fields are kept and go back to the list on the right.`)) {
                        void removeSection(block.key);
                      }
                    }}
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
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {field?.label ?? fieldName}
                              {field?.isMandatory && <span className="ml-0.5 text-negative">*</span>}
                            </span>
                            {layoutType === 'detail' && (
                              <span className="block truncate text-2xs text-muted">{sampleOf(fieldName) || '—'}</span>
                            )}
                          </span>
                          {/*
                            Everything a drag does, without a drag: on a long
                            form the target section is off screen, and a laptop
                            trackpad is a poor tool for carrying a field there.
                          */}
                          <Dropdown
                            trigger={
                              <span className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-700" title={`Move ${field?.label ?? fieldName}`} aria-label={`Move ${field?.label ?? fieldName}`}>
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </span>
                            }
                          >
                            {fieldIndex > 0 && (
                              <DropdownItem icon={<ChevronUp className="h-3.5 w-3.5" />} onClick={() => move(block.key, fieldName, block.key, fieldIndex - 1)}>Move up</DropdownItem>
                            )}
                            {fieldIndex < block.fields.length - 1 && (
                              <DropdownItem icon={<ChevronDown className="h-3.5 w-3.5" />} onClick={() => move(block.key, fieldName, block.key, fieldIndex + 1)}>Move down</DropdownItem>
                            )}
                            {blocks.filter((other) => other.key !== block.key).map((other) => (
                              <DropdownItem key={other.key} onClick={() => move(block.key, fieldName, other.key, other.fields.length)}>
                                Move to {other.label}
                              </DropdownItem>
                            ))}
                            <DropdownItem
                              danger
                              icon={<Trash2 className="h-3.5 w-3.5" />}
                              onClick={() => {
                                setBlocks((prev) => prev.map((b) =>
                                  b.key === block.key ? { ...b, fields: b.fields.filter((f) => f !== fieldName) } : b));
                                touch();
                              }}
                            >
                              Take off the form
                            </DropdownItem>
                          </Dropdown>
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

            <button onClick={() => setNewSection(true)} className="btn-secondary btn-sm">
              <Plus className="h-3.5 w-3.5" /> Add section
            </button>

            {/*
              The one list here that is not the split view: the WhatsApp Chats
              screen shows the same record beside a conversation, with a strip
              of facts above it. It keeps its own list, and says plainly which
              screen it changes.
            */}
            {layoutType === 'detail' && (
              <Zone
                step={5}
                title="WhatsApp chat — facts above the conversation"
                hint="The strip of facts beside a customer’s name on the WhatsApp Chats screen."
                testId="zone-chat"
              >
                <OrderedFieldList
                  label="WhatsApp chat facts"
                  value={headerFields}
                  options={fieldOptions}
                  sampleOf={sampleOf}
                  onChange={(next) => { setHeaderFields(next); setHeaderTouched(true); touch(); }}
                  emptyText="No facts — only the name and the agent show."
                />
              </Zone>
            )}
          </div>

          {/*
            Unplaced fields.

            `sticky`, searchable, and every row has a button as well as a drag
            handle — three answers to the same complaint: "when I scroll down in
            the field list it just remains on the top, how can I drag and put
            somewhere". Dragging across a scrolling page is the wrong tool for a
            module with sixty fields and ten sections; the panel follows the
            scroll now so the target is always beside the source, and picking a
            section from a menu does the same job without a drag at all.
          */}
          <div className="sticky top-4 h-fit self-start">
            <div className="card overflow-hidden">
              <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                <p className="text-xs font-medium text-muted">
                  Unplaced fields ({unplaced.length}{search ? ` of ${availableFields.length}` : ''})
                </p>
              </div>
              <div className="border-b border-slate-100 p-2 dark:border-slate-800">
                <input
                  className="input py-1 text-xs"
                  placeholder="Search fields…"
                  aria-label="Search unplaced fields"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="max-h-[26rem] space-y-1 overflow-y-auto p-2">
                {unplaced.map((field) => (
                  <div
                    key={field.name}
                    draggable
                    onDragStart={() => setDragging({ block: '', field: field.name })}
                    onDragEnd={() => setDragging(null)}
                    className="group flex cursor-grab items-center gap-1.5 rounded-lg border border-dashed border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700"
                  >
                    <GripVertical className="h-3 w-3 shrink-0 text-slate-300" />
                    <span className="min-w-0 flex-1 truncate" title={field.label}>{field.label}</span>
                    <Badge>{field.uitype}</Badge>
                    {/*
                      The drag-free path. The section list is short and it is
                      the same `move` the drop handler calls, so the two cannot
                      disagree about where a field lands.
                    */}
                    <Dropdown
                      trigger={
                        <span
                          className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-700"
                          title={`Add ${field.label} to a section`}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </span>
                      }
                    >
                      {blocks.map((b) => (
                        <DropdownItem
                          key={b.key}
                          onClick={() => { move('', field.name, b.key, b.fields.length); }}
                        >
                          {b.label}
                        </DropdownItem>
                      ))}
                      {blocks.length === 0 && <DropdownItem onClick={() => setNewSection(true)}>Add a section first…</DropdownItem>}
                    </Dropdown>
                  </div>
                ))}
                {availableFields.length === 0 && (
                  <p className="py-6 text-center text-xs text-muted">Every field is placed</p>
                )}
                {availableFields.length > 0 && unplaced.length === 0 && (
                  <p className="py-6 text-center text-xs text-muted">Nothing matches “{search}”</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Names a new section before it is created, in the same styled dialog the
 * rest of the admin uses. It replaced a bare window.prompt, which broke the
 * app's own look and gave no Escape handling worth the name.
 */
function NewSectionDialog({ onClose, onSave }: { onClose: () => void; onSave: (label: string) => void }): JSX.Element {
  const [label, setLabel] = useState('');
  const ready = label.trim().length > 0;
  return (
    <Modal
      open
      onClose={onClose}
      title="New section"
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!ready}
            onClick={() => onSave(label.trim())}
          >
            Create section
          </button>
        </>
      }
    >
      <label className="label" htmlFor="new-section-label">Section name</label>
      <input
        id="new-section-label"
        className="input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && ready) onSave(label.trim()); }}
        autoFocus
      />
      <p className="mt-1.5 text-2xs text-muted">
        The section is added to the end of this layout; drag it where you want it.
      </p>
    </Modal>
  );
}
