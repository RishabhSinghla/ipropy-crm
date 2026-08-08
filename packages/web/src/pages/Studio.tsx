/**
 * Studio — turn a listing into a social post without leaving the CRM.
 *
 * Scoped deliberately. This is not a general design tool: it exists so that
 * "we just listed B-904" becomes an Instagram or WhatsApp post in under a
 * minute, using the listing data and photos the CRM already holds. Pick a
 * property, pick a template, adjust the words, export — or save it straight
 * onto the record so it can be sent from the conversation later.
 *
 * The preview is the exported file: both go through `renderDesign` onto a
 * canvas at full output resolution, scaled down only by CSS for display. There
 * is no second rendering path that could disagree with what you saw.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Image as ImageIcon, Paperclip, Search, Sparkles, Type, Wand2 } from 'lucide-react';
import { api, authedFileUrl } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { CANVAS_PRESETS, layerLabel, renderDesign, type Design, type Layer } from '../lib/design';
import { TEMPLATES, listingFromProperty, type BrandData, type ListingData } from '../lib/designTemplates';
import { EmptyState, Select, Spinner } from '../components/ui';

export default function Studio(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [presetKey, setPresetKey] = useState(CANVAS_PRESETS[0].key);
  const [templateKey, setTemplateKey] = useState(TEMPLATES[0].key);
  const [search, setSearch] = useState('');
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [design, setDesign] = useState<Design | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const selectedProperty = properties?.rows.find((r) => r.id === propertyId) ?? null;

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
    return listingFromProperty(selectedProperty.values, selectedProperty.display, imageUrl);
  }, [selectedProperty]);

  // Rebuild whenever the inputs change. Edits live in `design`, so changing
  // template or size deliberately discards them — that is the same decision
  // every editor makes about switching layout.
  useEffect(() => {
    setDesign(template.build(listing, brandData, preset.size));
    setSelectedId(null);
  }, [template, listing, brandData, preset.size]);

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
    URL.revokeObjectURL(url);
  };

  const saveToRecord = async (): Promise<void> => {
    if (!selectedProperty) { toast.error('Pick a property first'); return; }
    setBusy(true);
    try {
      const blob = await exportBlob();
      if (!blob) throw new Error('Could not render the image');
      const file = new File([blob], `post-${preset.key}-${Date.now()}.png`, { type: 'image/png' });
      await api.uploadFile(file, selectedProperty.id, 'properties');
      toast.success('Saved to the property', 'Find it under Files — ready to send on WhatsApp.');
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Studio</h1>
        <p className="text-sm text-muted">
          Turn a listing into a post for Instagram, Facebook or WhatsApp — using the photos and
          prices already in the CRM.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {/* Controls */}
        <div className="space-y-4">
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
                  onClick={() => setPropertyId(row.id)}
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
                  onClick={() => setTemplateKey(t.key)}
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
              onChange={setPresetKey}
              options={CANVAS_PRESETS.map((p) => ({ value: p.key, label: `${p.label} — ${p.note}` }))}
            />
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
    </div>
  );
}
