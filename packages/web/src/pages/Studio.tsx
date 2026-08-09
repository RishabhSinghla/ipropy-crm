/**
 * Studio — turn a listing into something postable without leaving the CRM.
 *
 * Four outputs, because those are the four a property desk actually ships: a
 * social post, a reel, a brochure PDF, and a photo that has been tidied up.
 * Deliberately not a general design tool — five good templates that fill
 * themselves from the record beat a blank canvas nobody has time for.
 *
 * Posts render in the browser, where the preview *is* the export: both go
 * through `renderDesign` onto a canvas at full output resolution, scaled down
 * only by CSS. There is no second rendering path that could disagree with what
 * you saw. Reels and brochures cannot work that way — ffmpeg and a PDF writer
 * do not run in a phone browser — so those queue a job on the server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download, FileText, Film, FolderOpen, Image as ImageIcon, Paperclip, Save, Search, Sparkles, Trash2, Type,
} from 'lucide-react';
import { api, authedFileUrl, type SavedDesign } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { CANVAS_PRESETS, layerLabel, renderDesign, type Design, type Layer } from '../lib/design';
import { TEMPLATES, listingFromProperty, type BrandData, type ListingData } from '../lib/designTemplates';
import { EmptyState, Select, Spinner, Tabs } from '../components/ui';
import { BrochureBuilder, PhotoEditor, ReelBuilder, type SelectedProperty } from '../components/StudioPanels';

type StudioTab = 'post' | 'reel' | 'brochure' | 'photo';

export default function Studio(): JSX.Element {
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const preserveSavedDesign = useRef(false);
  const [tab, setTab] = useState<StudioTab>('post');
  const [presetKey, setPresetKey] = useState(CANVAS_PRESETS[0].key);
  const [templateKey, setTemplateKey] = useState(TEMPLATES[0].key);
  const [search, setSearch] = useState('');
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [design, setDesign] = useState<Design | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedDesignId, setSavedDesignId] = useState<string | null>(null);
  const [designName, setDesignName] = useState('');
  const [previousPrice, setPreviousPrice] = useState('');

  const { data: capabilities } = useQuery({
    queryKey: ['studio-capabilities'],
    queryFn: () => api.studioCapabilities(),
    staleTime: 300_000,
  });

  const preset = CANVAS_PRESETS.find((p) => p.key === presetKey)!;
  const template = TEMPLATES.find((t) => t.key === templateKey)!;

  const { data: brand } = useQuery({ queryKey: ['brand'], queryFn: () => api.brand(), staleTime: 600_000 });

  const { data: properties, isLoading: loadingProps } = useQuery({
    queryKey: ['studio-properties', search],
    queryFn: () => api.list('properties', {
      page: 1, pageSize: 12, search: search || undefined,
      columns: ['name', 'project_id', 'configuration', 'carpet_area', 'facing', 'floor', 'base_price', 'total_price', 'gallery', 'status'],
    }),
  });

  const listedProperty = properties?.rows.find((r) => r.id === propertyId) ?? null;
  const { data: fetchedProperty } = useQuery({
    queryKey: ['record', 'properties', propertyId],
    queryFn: () => api.record('properties', propertyId!),
    enabled: Boolean(propertyId && !listedProperty),
  });
  const baseSelectedProperty = listedProperty ?? fetchedProperty ?? null;

  const { data: propertyFiles } = useQuery({
    queryKey: ['files', propertyId],
    queryFn: () => api.files(propertyId!),
    enabled: Boolean(propertyId),
  });

  const selectedProperty = useMemo(() => {
    if (!baseSelectedProperty) return null;
    const files = (propertyFiles ?? []) as {
      id: string; mime_type: string; file_name: string;
    }[];
    const imageFiles = files.filter((file) => file.mime_type.startsWith('image/'));
    const attachedIds = new Set(imageFiles.map((file) => file.id));
    const rawGallery = Array.isArray(baseSelectedProperty.values.gallery)
      ? baseSelectedProperty.values.gallery
      : baseSelectedProperty.values.gallery ? [baseSelectedProperty.values.gallery] : [];
    const validGallery = rawGallery.filter((value): value is string => {
      if (typeof value !== 'string' || !value) return false;
      const match = /^\/api\/files\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(value);
      return !match || attachedIds.has(match[1]);
    });
    const gallery = [
      ...imageFiles.map((file) => `/api/files/${file.id}`),
      ...validGallery,
    ].filter((url, index, all) => all.indexOf(url) === index);
    return {
      ...baseSelectedProperty,
      values: { ...baseSelectedProperty.values, gallery },
    };
  }, [baseSelectedProperty, propertyFiles]);

  const { data: savedDesigns } = useQuery({
    queryKey: ['studio-designs', 'post'],
    queryFn: () => api.designs({ kind: 'post' }),
  });

  const brandData: BrandData = useMemo(() => ({
    name: brand?.orgName ?? 'iPropy',
    // Falls back to the app's own brand hue rather than black, which looks
    // like a rendering failure rather than a choice.
    colour: '#6366f1',
    phone: brand?.phone ?? null,
    tagline: brand?.tagline ?? null,
  }), [brand]);

  const listing: ListingData = useMemo(() => {
    if (!selectedProperty) {
      return {
        title: 'Select a property',
        subtitle: 'Its photo, price and details fill in automatically.',
        price: '₹—',
        facts: [],
        imageUrl: null,
      };
    }
    const gallery = selectedProperty.values.gallery;
    const first = Array.isArray(gallery) ? gallery[0] : gallery;
    // `medium` rather than the original: a 4MB phone photo decodes slowly and
    // the largest canvas here is 1080px wide.
    const imageUrl = typeof first === 'string' && first
      ? authedFileUrl(first, { size: 'medium' })
      : null;
    return {
      ...listingFromProperty(selectedProperty.values, selectedProperty.display, imageUrl),
      previousPrice: previousPrice.trim() || null,
    };
  }, [selectedProperty, previousPrice]);

  // Rebuild whenever the inputs change. Edits live in `design`, so changing
  // template or size deliberately discards them — that is the same decision
  // every editor makes about switching layout.
  useEffect(() => {
    // Opening an old design can trigger several asynchronous input changes:
    // its property fetch, brand fetch, template and size. Keep the saved pixels
    // intact until the user deliberately changes one of those inputs.
    if (preserveSavedDesign.current) return;
    setDesign(template.build(listing, brandData, preset.size));
    setSavedDesignId(null);
    setSelectedId(null);
  }, [template, listing, brandData, preset.size]);

  const chooseProperty = (id: string): void => {
    preserveSavedDesign.current = false;
    setPropertyId(id);
  };

  const chooseTemplate = (key: string): void => {
    preserveSavedDesign.current = false;
    setTemplateKey(key);
  };

  const choosePreset = (key: string): void => {
    preserveSavedDesign.current = false;
    setPresetKey(key);
  };

  const draw = useCallback(async () => {
    if (canvasRef.current && design) await renderDesign(canvasRef.current, design);
  }, [design]);

  useEffect(() => { void draw(); }, [draw]);

  const updateLayer = (layerId: string, patch: Partial<Layer>): void => {
    setDesign((d) => d && ({
      ...d,
      layers: d.layers.map((l) => (l.id === layerId ? { ...l, ...patch } as Layer : l)),
    }));
  };

  const selected = design?.layers.find((l) => l.id === selectedId) ?? null;

  const exportBlob = async (): Promise<Blob | null> => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    await draw(); // ensure the latest edit is on the canvas, not a stale frame
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  };

  const download = async (): Promise<void> => {
    const blob = await exportBlob();
    if (!blob) { toast.error('Could not render the image'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(selectedProperty?.label ?? 'ipropy-post').replace(/[^\w-]+/g, '-').toLowerCase()}-${preset.key}.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const saveToRecord = async (): Promise<void> => {
    if (!selectedProperty) { toast.error('Pick a property first'); return; }
    setBusy(true);
    try {
      const blob = await exportBlob();
      if (!blob) throw new Error('Could not render the image');
      const file = new File([blob], `post-${preset.key}-${Date.now()}.png`, { type: 'image/png' });
      await api.uploadFile(file, selectedProperty.id, 'properties');
      void queryClient.invalidateQueries({ queryKey: ['files', selectedProperty.id] });
      toast.success('Saved to the property', 'Find it under Files — ready to send on WhatsApp.');
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveDesign = useMutation({
    mutationFn: async () => {
      if (!design) throw new Error('There is no design to save');
      const thumbnail = await designThumbnail(canvasRef.current);
      const payload = {
        name: designName.trim() || `${selectedProperty?.label ?? 'Untitled'} — ${template.label}`,
        kind: 'post',
        templateKey,
        recordId: selectedProperty?.id ?? null,
        module: selectedProperty ? 'properties' : null,
        width: design.size.width,
        height: design.size.height,
        spec: serialiseDesign(design),
        thumbnail,
      };
      if (savedDesignId) {
        await api.updateDesign(savedDesignId, payload);
        return { id: savedDesignId };
      }
      return api.saveDesign(payload);
    },
    onSuccess: ({ id }) => {
      setSavedDesignId(id);
      void queryClient.invalidateQueries({ queryKey: ['studio-designs', 'post'] });
      toast.success('Design saved');
    },
    onError: (err: Error) => toast.error('Could not save the design', err.message),
  });

  const openSavedDesign = async (saved: SavedDesign): Promise<void> => {
    setBusy(true);
    try {
      const full = await api.design(saved.id);
      const restored = hydrateDesign(full.spec);
      if (!restored) throw new Error('This saved design is not valid');
      preserveSavedDesign.current = true;
      setDesign(restored);
      setSavedDesignId(saved.id);
      setDesignName(saved.name);
      setPropertyId(saved.record_id);
      if (saved.template_key && TEMPLATES.some((item) => item.key === saved.template_key)) {
        setTemplateKey(saved.template_key);
      }
      const matchingPreset = CANVAS_PRESETS.find((item) => (
        item.size.width === restored.size.width && item.size.height === restored.size.height
      ));
      if (matchingPreset) setPresetKey(matchingPreset.key);
      setSelectedId(null);
      setTab('post');
    } catch (err) {
      toast.error('Could not open the design', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteSavedDesign = useMutation({
    mutationFn: (id: string) => api.deleteDesign(id),
    onSuccess: (_result, id) => {
      if (savedDesignId === id) setSavedDesignId(null);
      void queryClient.invalidateQueries({ queryKey: ['studio-designs', 'post'] });
      toast.success('Design deleted');
    },
    onError: (err: Error) => toast.error('Could not delete the design', err.message),
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Studio</h1>
        <p className="text-sm text-muted">
          Posts, reels, brochures and photo edits — built from the listings already in the CRM.
        </p>
      </div>

      <Tabs
        className="mb-4"
        active={tab}
        onChange={(k) => setTab(k as StudioTab)}
        tabs={[
          { key: 'post', label: 'Post', icon: <ImageIcon className="h-4 w-4" /> },
          { key: 'reel', label: 'Reel', icon: <Film className="h-4 w-4" /> },
          { key: 'brochure', label: 'Brochure', icon: <FileText className="h-4 w-4" /> },
          { key: 'photo', label: 'Photo edit', icon: <Sparkles className="h-4 w-4" /> },
        ]}
      />

      {tab !== 'post' && (
        <div className="mb-4 card p-4">
          <PropertyPicker
            search={search}
            onSearch={setSearch}
            rows={properties?.rows ?? []}
            loading={loadingProps}
            selectedId={propertyId}
            onSelect={chooseProperty}
          />
        </div>
      )}

      {tab === 'reel' && (
        <ReelBuilder
          property={selectedProperty as SelectedProperty | null}
          videoAvailable={capabilities?.video ?? false}
          musicAvailable={capabilities?.music ?? false}
        />
      )}
      {tab === 'brochure' && <BrochureBuilder property={selectedProperty as SelectedProperty | null} />}
      {tab === 'photo' && (
        <PhotoEditor
          property={selectedProperty as SelectedProperty | null}
          imageEditAvailable={capabilities?.imageEdit ?? false}
          presets={capabilities?.presets ?? []}
        />
      )}

      {tab === 'post' && (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {/* Controls */}
        <div className="space-y-4">
          <div className="card space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <label className="label mb-0">Saved designs</label>
              <span className="text-2xs text-muted">{savedDesigns?.length ?? 0}</span>
            </div>
            {(savedDesigns?.length ?? 0) > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {savedDesigns!.slice(0, 6).map((saved) => (
                  <div key={saved.id} className="group relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                    <button className="block w-full text-left" onClick={() => void openSavedDesign(saved)}>
                      {saved.thumbnail ? (
                        <img src={saved.thumbnail} alt="" className="aspect-video w-full object-cover" />
                      ) : (
                        <span className="flex aspect-video items-center justify-center bg-slate-50 dark:bg-slate-900">
                          <FolderOpen className="h-5 w-5 text-muted" />
                        </span>
                      )}
                      <span className="block truncate px-2 py-1.5 text-2xs font-medium">{saved.name}</span>
                    </button>
                    <button
                      className="absolute right-1 top-1 rounded bg-white/90 p-1 text-slate-500 opacity-0 shadow group-hover:opacity-100 dark:bg-slate-900/90"
                      onClick={() => deleteSavedDesign.mutate(saved.id)}
                      aria-label={`Delete ${saved.name}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">Save a post once, then reopen it when the price or status changes.</p>
            )}
            <div className="flex gap-2">
              <input
                className="input min-w-0 flex-1"
                value={designName}
                onChange={(event) => setDesignName(event.target.value)}
                placeholder={selectedProperty ? `${selectedProperty.label} post` : 'Design name'}
              />
              <button
                className="btn-secondary btn-sm shrink-0"
                disabled={!design || saveDesign.isPending}
                onClick={() => saveDesign.mutate()}
              >
                {saveDesign.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                {savedDesignId ? 'Update' : 'Save'}
              </button>
            </div>
          </div>

          <div className="card p-4">
            <label className="label">1 · Property</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="input pl-8"
                placeholder="Search units…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {loadingProps && <div className="flex justify-center py-4"><Spinner className="text-slate-400" /></div>}
              {(properties?.rows ?? []).map((row) => (
                <button
                  key={row.id}
                  onClick={() => chooseProperty(row.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors',
                    propertyId === row.id
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
                      : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
                  <span className="shrink-0 text-2xs text-muted">{String(row.values.configuration ?? '')}</span>
                </button>
              ))}
              {!loadingProps && (properties?.rows ?? []).length === 0 && (
                <p className="py-4 text-center text-xs text-muted">No units match “{search}”.</p>
              )}
            </div>
          </div>

          <div className="card p-4">
            <label className="label">2 · Template</label>
            <div className="space-y-1.5">
              {TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => chooseTemplate(t.key)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    templateKey === t.key
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
                      : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  <p className="text-xs font-medium">{t.label}</p>
                  <p className="mt-0.5 text-2xs text-muted">{t.description}</p>
                </button>
              ))}
            </div>

            <label className="label mt-4">Size</label>
            <Select
              value={presetKey}
              onChange={choosePreset}
              options={CANVAS_PRESETS.map((p) => ({ value: p.key, label: `${p.label} — ${p.note}` }))}
            />

            {templateKey === 'price_cut' && (
              <div className="mt-3">
                <label className="label">Previous price (optional)</label>
                <input
                  className="input"
                  value={previousPrice}
                  onChange={(event) => {
                    preserveSavedDesign.current = false;
                    setPreviousPrice(event.target.value);
                  }}
                  placeholder="₹1.85 Cr"
                />
              </div>
            )}
          </div>

          <div className="card p-4">
            <label className="label">3 · Edit</label>
            {!design ? (
              <p className="text-xs text-muted">Nothing to edit yet.</p>
            ) : (
              <>
                <div className="space-y-1">
                  {design.layers.filter((l) => l.type === 'text').map((l) => (
                    <button
                      key={l.id}
                      onClick={() => setSelectedId(l.id === selectedId ? null : l.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        selectedId === l.id ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300' : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                      )}
                    >
                      <Type className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate">{layerLabel(l)}</span>
                    </button>
                  ))}
                </div>

                {selected?.type === 'text' && (
                  <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <div>
                      <label className="label">Text</label>
                      <textarea
                        className="input min-h-[4rem] text-xs"
                        value={selected.text}
                        onChange={(e) => updateLayer(selected.id, { text: e.target.value })}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="label">Size</label>
                        <input
                          type="number"
                          className="input"
                          value={selected.size}
                          onChange={(e) => updateLayer(selected.id, { size: Number(e.target.value) || 12 })}
                        />
                      </div>
                      <div>
                        <label className="label">Colour</label>
                        <input
                          type="color"
                          className="input h-9 p-1"
                          // A colour input cannot show rgba(), which several
                          // template layers use for a translucent caption.
                          value={/^#[0-9a-f]{6}$/i.test(selected.color) ? selected.color : '#ffffff'}
                          onChange={(e) => updateLayer(selected.id, { color: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Preview */}
        <div className="card flex flex-col items-center gap-4 p-4">
          {design ? (
            <>
              <div className="w-full max-w-md overflow-hidden rounded-lg bg-slate-100 shadow-inner dark:bg-slate-800">
                <canvas
                  ref={canvasRef}
                  className="block h-auto w-full"
                  // Rendered at full output resolution and scaled by CSS, so
                  // the preview is literally the exported pixels.
                  style={{ aspectRatio: `${preset.size.width} / ${preset.size.height}` }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                <button className="btn-primary btn-sm" onClick={() => void download()}>
                  <Download className="h-3.5 w-3.5" /> Download PNG
                </button>
                <button className="btn-secondary btn-sm" disabled={busy || !selectedProperty} onClick={() => void saveToRecord()}>
                  {busy ? <Spinner className="h-3 w-3" /> : <Paperclip className="h-3.5 w-3.5" />}
                  Save to the property
                </button>
              </div>

              <p className="text-center text-2xs text-muted">
                {preset.size.width} × {preset.size.height}px · exported at full resolution
              </p>
            </>
          ) : (
            <EmptyState icon={<ImageIcon className="h-10 w-10" />} title="Pick a property to start" />
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function serialiseDesign(design: Design): Design {
  return {
    ...design,
    layers: design.layers.map((layer) => {
      if (layer.type !== 'image' || !layer.src.startsWith('/api/')) return layer;
      const url = new URL(layer.src, window.location.origin);
      url.searchParams.delete('access_token');
      return { ...layer, src: `${url.pathname}${url.search}` };
    }),
  };
}

function hydrateDesign(value: Record<string, unknown>): Design | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as unknown as Design;
  if (!candidate.size || !Number.isFinite(candidate.size.width) || !Number.isFinite(candidate.size.height)
      || !Array.isArray(candidate.layers) || typeof candidate.background !== 'string') return null;
  return {
    ...candidate,
    layers: candidate.layers.map((layer) => (
      layer.type === 'image' && layer.src.startsWith('/api/')
        ? { ...layer, src: authedFileUrl(layer.src) }
        : layer
    )),
  };
}

async function designThumbnail(canvas: HTMLCanvasElement | null): Promise<string | null> {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const width = 240;
  const height = Math.max(80, Math.round(width * canvas.height / canvas.width));
  const preview = document.createElement('canvas');
  preview.width = width;
  preview.height = height;
  preview.getContext('2d')?.drawImage(canvas, 0, 0, width, height);
  return preview.toDataURL('image/jpeg', 0.72);
}

/**
 * The property list, shared by the three server-rendered tabs.
 *
 * Extracted rather than duplicated because the post tab's copy has its own
 * numbered-step framing ("1 · Property") that would read oddly on a tab where
 * it is the only control.
 */
function PropertyPicker({
  search, onSearch, rows, loading, selectedId, onSelect,
}: {
  search: string;
  onSearch: (value: string) => void;
  rows: { id: string; label: string; values: Record<string, unknown> }[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <>
      <label className="label">Property</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="input pl-8"
          placeholder="Search units…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
        {loading && <Spinner className="text-slate-400" />}
        {rows.map((row) => (
          <button
            key={row.id}
            onClick={() => onSelect(row.id)}
            className={cn(
              'rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
              selectedId === row.id
                ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
                : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
            )}
          >
            {row.label}
          </button>
        ))}
      </div>
    </>
  );
}
