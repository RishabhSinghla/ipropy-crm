/**
 * The studio's server-rendered panels: reels, brochures and photo editing.
 *
 * Posts are drawn in the browser because the canvas renderer can be both the
 * preview and the export. These three cannot be: ffmpeg and a PDF writer do not
 * run in a phone browser, and the AI edit needs a key that must never reach the
 * client. So each of these submits a job and watches it, which is also why they
 * live here rather than inside the post editor's render loop.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Check, Clock, Download, FileText, Film, RefreshCw, Sparkles, Upload, Wand2, X,
} from 'lucide-react';
import { api, authedFileUrl, type RenderJob } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { formatIndianPrice } from '@ipropy/shared';
import { Card, EmptyState, Input, Select, Spinner, Textarea, Toggle } from './ui';
import {
  NEUTRAL, applyAdjustments, dataUrlToBlob, hasTransparency, imageDataToDataUrl, loadImageData,
  removeFlatBackground, type Adjustments,
} from '../lib/imageTools';

export interface SelectedProperty {
  id: string;
  label: string;
  values: Record<string, unknown>;
  display?: Record<string, string>;
}

/** Every photo on the record, as same-origin URLs the server can also fetch. */
function galleryUrls(property: SelectedProperty | null): string[] {
  if (!property) return [];
  const gallery = property.values.gallery;
  const list = Array.isArray(gallery) ? gallery : gallery ? [gallery] : [];
  return list.filter((u): u is string => typeof u === 'string' && u.length > 0);
}

// ---------------------------------------------------------------------------
// Render job status — shared by reels and brochures
// ---------------------------------------------------------------------------

function JobCard({ job }: { job: RenderJob }): JSX.Element {
  const done = job.status === 'completed';
  const broken = job.status === 'failed';
  const unsupported = job.status === 'unsupported';
  const [downloading, setDownloading] = useState(false);

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const response = await api.renderFile(job.id);
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const headerName = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
      const filename = headerName ?? `ipropy-${job.kind}-${job.id.slice(0, 8)}.${job.kind === 'reel' ? 'mp4' : 'pdf'}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      toast.error('Could not download the render', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className="flex flex-wrap items-center gap-3 p-3">
      <div className="shrink-0">
        {done ? <Check className="h-5 w-5 text-emerald-600" />
          : broken ? <X className="h-5 w-5 text-red-600" />
            : unsupported ? <AlertTriangle className="h-5 w-5 text-amber-600" />
              : <Spinner className="h-5 w-5 text-brand-600" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {job.kind === 'reel' ? 'Reel' : 'Brochure'}
          {job.record_label ? ` · ${job.record_label}` : ''}
        </p>
        <p className="text-2xs text-muted">
          {done ? 'Ready'
            : broken ? (job.error ?? 'Failed')
              : unsupported ? (job.error ?? 'Not available on this server')
                : job.status === 'running' ? 'Rendering…' : 'Queued'}
        </p>
      </div>
      {done && (
        <button onClick={() => void download()} disabled={downloading} className="btn-secondary btn-sm shrink-0">
          {downloading ? <Spinner className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          {downloading ? 'Downloading…' : 'Download'}
        </button>
      )}
    </Card>
  );
}

function RenderQueue(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['renders'],
    queryFn: () => api.renders(),
    // Poll only while something is in flight; a finished list is static.
    refetchInterval: (query) => {
      const jobs = query.state.data as RenderJob[] | undefined;
      return jobs?.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false;
    },
  });

  const recent = (data ?? []).slice(0, 5);
  if (!recent.length) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Recent renders</h3>
      {recent.map((job) => <JobCard key={job.id} job={job} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reels
// ---------------------------------------------------------------------------

export function ReelBuilder({
  property, videoAvailable, musicAvailable,
}: { property: SelectedProperty | null; videoAvailable: boolean; musicAvailable: boolean }): JSX.Element {
  const client = useQueryClient();
  const photos = useMemo(() => galleryUrls(property), [property]);
  const photoKey = photos.join('\n');

  const [chosen, setChosen] = useState<string[]>([]);
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [seconds, setSeconds] = useState(3);
  const [cta, setCta] = useState('Book a site visit');
  const [music, setMusic] = useState(false);

  // Default to all photos when the property changes; re-picking eight photos
  // for every reel is the kind of friction that stops people making them.
  useEffect(() => { setChosen(photos.slice(0, 12)); setCaptions({}); }, [property?.id, photoKey]);

  const price = Number(property?.values.total_price ?? property?.values.base_price ?? 0);

  const queue = useMutation({
    mutationFn: () => api.queueReel({
      title: property?.label ?? 'Property',
      subtitle: [property?.values.locality, property?.values.city].filter(Boolean).join(', ') || undefined,
      price: price > 0 ? formatIndianPrice(price) : undefined,
      cta,
      secondsPerSlide: seconds,
      music: musicAvailable && music,
      recordId: property?.id ?? null,
      slides: chosen.map((url) => ({ url, caption: captions[url] || undefined })),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['renders'] });
      toast.success('Reel queued', 'It takes about a minute. You will get a notification when it is ready.');
    },
    onError: (err: Error) => toast.error('Could not start the render', err.message),
  });

  if (!videoAvailable) {
    return (
      <Card className="space-y-2 p-4">
        <div className="flex items-center gap-2 text-amber-600">
          <AlertTriangle className="h-4 w-4" />
          <p className="text-sm font-medium">Video rendering is not available on this server</p>
        </div>
        <p className="text-sm text-muted">
          Reels need <code>ffmpeg</code> installed where the CRM runs. Everything else in the studio —
          posts, brochures and photo editing — works without it.
        </p>
      </Card>
    );
  }

  if (!property) {
    return <EmptyState icon={<Film className="h-8 w-8" />} title="Pick a property to build a reel" />;
  }

  if (!photos.length) {
    return (
      <EmptyState
        icon={<Film className="h-8 w-8" />}
        title="This property has no photos yet"
        body="Add photos to the property record and they will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Photos — {chosen.length} selected, in this order</label>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((url, photoIndex) => {
            const index = chosen.indexOf(url);
            const selected = index >= 0;
            return (
              <button
                key={url}
                onClick={() => setChosen((prev) => (selected ? prev.filter((u) => u !== url) : [...prev, url]))}
                aria-label={`${selected ? 'Remove' : 'Add'} photo ${photoIndex + 1} ${selected ? 'from' : 'to'} reel`}
                className={cn(
                  'relative aspect-square overflow-hidden rounded-lg border-2 transition-colors',
                  selected ? 'border-brand-500' : 'border-transparent opacity-60 hover:opacity-100',
                )}
              >
                <img src={authedFileUrl(url, { size: 'thumb' })} alt="" className="h-full w-full object-cover" />
                {selected && (
                  <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-2xs font-bold text-white">
                    {index + 1}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {chosen.length > 0 && (
        <div>
          <label className="label">Captions (optional)</label>
          <div className="space-y-2">
            {chosen.slice(0, 6).map((url, i) => (
              <div key={url} className="flex items-center gap-2">
                <img src={authedFileUrl(url, { size: 'thumb' })} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                <Input
                  value={captions[url] ?? ''}
                  onChange={(e) => setCaptions((prev) => ({ ...prev, [url]: e.target.value }))}
                  placeholder={`Slide ${i + 1} — e.g. "Double-height living room"`}
                  className="flex-1"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Seconds per photo</label>
          <Select
            value={String(seconds)}
            onChange={(v) => setSeconds(Number(v))}
            options={[
              { value: '2', label: '2s — quick' },
              { value: '3', label: '3s — standard' },
              { value: '4', label: '4s — slow' },
            ]}
          />
        </div>
        <div>
          <label className="label">Closing line</label>
          <Input value={cta} onChange={(e) => setCta(e.target.value)} />
        </div>
      </div>

      <p className="text-2xs text-muted">
        1080 × 1920, about {Math.round(2.5 + chosen.length * seconds + 2.5)}s — a title card, your photos
        with a slow pan, then the closing line.
      </p>

      {musicAvailable && (
        <Toggle
          checked={music}
          onChange={setMusic}
          label="Add the licensed background track installed on this server"
        />
      )}
      {!musicAvailable && (
        <p className="text-2xs text-muted">
          No licensed background track is installed yet, so this reel renders silently with motion and captions.
        </p>
      )}

      <button
        onClick={() => queue.mutate()}
        disabled={!chosen.length || queue.isPending}
        className="btn-primary"
      >
        {queue.isPending ? <Spinner className="h-4 w-4" /> : <Film className="h-4 w-4" />}
        Render reel
      </button>

      <RenderQueue />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brochures
// ---------------------------------------------------------------------------

export function BrochureBuilder({ property }: { property: SelectedProperty | null }): JSX.Element {
  const client = useQueryClient();
  const photos = useMemo(() => galleryUrls(property), [property]);

  const { data: brand } = useQuery({ queryKey: ['brand'], queryFn: () => api.brand(), staleTime: 600_000 });
  const [highlights, setHighlights] = useState('Vastu-compliant layout\nStilt parking\nModular kitchen\nGated, 24×7 security');
  const [description, setDescription] = useState('');

  const facts = useMemo(() => {
    const values = property?.values ?? {};
    const rows: { label: string; value: string }[] = [];
    const add = (label: string, value: unknown): void => {
      if (value !== null && value !== undefined && value !== '') rows.push({ label, value: String(value) });
    };
    add('Configuration', values.configuration);
    add('Carpet area', values.carpet_area ? `${values.carpet_area} sq ft` : null);
    add('Built-up area', values.built_up_area ? `${values.built_up_area} sq ft` : null);
    add('Facing', values.facing);
    add('Floor', values.floor);
    add('Status', values.status);
    add('Possession', values.possession_date);
    return rows;
  }, [property]);

  const price = Number(property?.values.total_price ?? property?.values.base_price ?? 0);

  const queue = useMutation({
    mutationFn: () => api.queueBrochure({
      title: property?.label ?? 'Property',
      subtitle: [property?.values.locality, property?.values.city].filter(Boolean).join(', ') || undefined,
      price: price > 0 ? formatIndianPrice(price) : undefined,
      description: description || undefined,
      facts,
      highlights: highlights.split('\n').map((h) => h.trim()).filter(Boolean),
      photos: photos.slice(0, 7).map((url) => ({ url })),
      orgName: brand?.orgName ?? 'iPropy',
      phone: brand?.phone ?? undefined,
      recordId: property?.id ?? null,
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['renders'] });
      toast.success('Brochure queued', 'A few seconds. You will get a notification when it is ready.');
    },
    onError: (err: Error) => toast.error('Could not start the render', err.message),
  });

  if (!property) {
    return <EmptyState icon={<FileText className="h-8 w-8" />} title="Pick a property to build a brochure" />;
  }

  return (
    <div className="space-y-4">
      <Card className="p-3">
        <p className="text-sm font-medium">{property.label}</p>
        <p className="text-2xs text-muted">
          {facts.length} specification{facts.length === 1 ? '' : 's'} and {photos.length} photo
          {photos.length === 1 ? '' : 's'} pulled from the record. The price on the PDF is the price in the CRM.
        </p>
      </Card>

      <div>
        <label className="label">Highlights — one per line</label>
        <Textarea value={highlights} onChange={(e) => setHighlights(e.target.value)} rows={5} />
      </div>

      <div>
        <label className="label">Description (optional)</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="A paragraph about the location, the builder, or what makes this unit worth seeing."
        />
      </div>

      <button onClick={() => queue.mutate()} disabled={queue.isPending} className="btn-primary">
        {queue.isPending ? <Spinner className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
        Generate PDF
      </button>

      <RenderQueue />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Photo editing
// ---------------------------------------------------------------------------

export function PhotoEditor({
  property, imageEditAvailable, presets,
}: {
  property: SelectedProperty | null;
  imageEditAvailable: boolean;
  presets: { key: string; label: string }[];
}): JSX.Element {
  const client = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uploadedObjectUrl = useRef<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [original, setOriginal] = useState<ImageData | null>(null);
  const [current, setCurrent] = useState<ImageData | null>(null);
  const [adjust, setAdjust] = useState<Adjustments>(NEUTRAL);
  const [preset, setPreset] = useState('enhance');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);

  const photos = useMemo(() => galleryUrls(property), [property]);

  useEffect(() => () => {
    if (uploadedObjectUrl.current) URL.revokeObjectURL(uploadedObjectUrl.current);
  }, []);

  const selectSource = (next: string, objectUrl = false): void => {
    if (uploadedObjectUrl.current) URL.revokeObjectURL(uploadedObjectUrl.current);
    uploadedObjectUrl.current = objectUrl ? next : null;
    setSource(next);
  };

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    void (async () => {
      const loaded = await loadImageData(source);
      if (cancelled || !loaded) return;
      setOriginal(loaded.data);
      setCurrent(loaded.data);
      setAdjust(NEUTRAL);
    })();
    return () => { cancelled = true; };
  }, [source]);

  // Adjustments always recompute from the original, never from the last result
  // — otherwise dragging a slider back to zero does not undo it, because each
  // pass would have been applied on top of the previous one.
  useEffect(() => {
    if (!original) return;
    setCurrent(adjust === NEUTRAL ? original : applyAdjustments(original, adjust));
  }, [original, adjust]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    canvas.getContext('2d')?.putImageData(current, 0, 0);
  }, [current]);

  const runAiEdit = async (): Promise<void> => {
    if (!current) return;
    setBusy(true);
    try {
      const dataUrl = imageDataToDataUrl(current, 'image/jpeg');
      const blob = await dataUrlToBlob(dataUrl);
      const result = await api.editImage(blob, preset, instruction || undefined);

      if (!result.ok || !result.dataUrl) {
        toast.error('The edit did not run', result.reason);
        return;
      }
      const loaded = await loadImageData(result.dataUrl);
      if (loaded) {
        // The AI result becomes the new baseline: sliders should adjust *it*,
        // not silently revert to the photo before staging.
        setOriginal(loaded.data);
        setCurrent(loaded.data);
        setAdjust(NEUTRAL);
        toast.success('Edited');
      }
    } catch (err) {
      toast.error('The edit failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cutOut = (): void => {
    if (!current) return;
    const cutout = removeFlatBackground(current);
    // A destructive edit becomes the new baseline, just like an AI result.
    // Otherwise moving any slider afterwards would silently restore the old
    // opaque background.
    setOriginal(cutout);
    setCurrent(cutout);
    setAdjust(NEUTRAL);
    toast.info('Background removed', 'Works on flat backgrounds — logos, plans, scans.');
  };

  const saveToRecord = async (): Promise<void> => {
    if (!current || !property) return;
    setBusy(true);
    try {
      const transparent = hasTransparency(current);
      const mime = transparent ? 'image/png' : 'image/jpeg';
      const extension = transparent ? 'png' : 'jpg';
      const blob = await dataUrlToBlob(imageDataToDataUrl(current, mime));
      const file = new File([blob], `edited-${Date.now()}.${extension}`, { type: mime });
      await api.uploadFile(file, property.id, 'properties');
      void client.invalidateQueries({ queryKey: ['files', property.id] });
      toast.success('Saved to the property');
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const download = (): void => {
    if (!current) return;
    const transparent = hasTransparency(current);
    const mime = transparent ? 'image/png' : 'image/jpeg';
    const extension = transparent ? 'png' : 'jpg';
    const a = document.createElement('a');
    a.href = imageDataToDataUrl(current, mime);
    a.download = `ipropy-photo-${Date.now()}.${extension}`;
    a.click();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        <div className="card p-4">
          <label className="label">Photo</label>
          {photos.length > 0 && (
            <div className="mb-2 grid grid-cols-4 gap-1.5">
              {photos.map((url, photoIndex) => (
                <button
                  key={url}
                  onClick={() => selectSource(authedFileUrl(url, { size: 'medium' }))}
                  aria-label={`Edit photo ${photoIndex + 1}`}
                  className={cn(
                    'aspect-square overflow-hidden rounded border-2',
                    source?.includes(url) ? 'border-brand-500' : 'border-transparent',
                  )}
                >
                  <img src={authedFileUrl(url, { size: 'thumb' })} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          <label className="btn-secondary btn-sm w-full cursor-pointer justify-center">
            <Upload className="h-3.5 w-3.5" /> Upload a photo
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) selectSource(URL.createObjectURL(file), true);
              }}
            />
          </label>
        </div>

        {current && (
          <>
            <div className="card space-y-3 p-4">
              <label className="label">Adjust</label>
              {(['brightness', 'contrast', 'saturation', 'sharpen'] as const).map((key) => (
                <div key={key}>
                  <div className="flex justify-between text-2xs text-muted">
                    <span className="capitalize">{key}</span>
                    <span className="tnum">{adjust[key]}</span>
                  </div>
                  <input
                    type="range"
                    aria-label={key[0].toUpperCase() + key.slice(1)}
                    min={key === 'sharpen' ? 0 : -100}
                    max={100}
                    value={adjust[key]}
                    onChange={(e) => setAdjust({ ...adjust, [key]: Number(e.target.value) })}
                    className="w-full"
                  />
                </div>
              ))}
              <button onClick={() => setAdjust(NEUTRAL)} className="btn-ghost btn-sm w-full">
                <RefreshCw className="h-3.5 w-3.5" /> Reset
              </button>
            </div>

            <div className="card space-y-3 p-4">
              <label className="label">AI edit</label>
              {imageEditAvailable ? (
                <>
                  <Select
                    value={preset}
                    onChange={setPreset}
                    options={presets.map((p) => ({ value: p.key, label: p.label }))}
                  />
                  {preset === 'custom' && (
                    <Textarea
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      rows={3}
                      placeholder="Describe the change — e.g. 'add warm evening lighting'"
                    />
                  )}
                  <button onClick={() => void runAiEdit()} disabled={busy} className="btn-primary btn-sm w-full">
                    {busy ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    Run
                  </button>
                  <p className="text-2xs text-muted">
                    AI edits can change visual details. Review every result and disclose virtual staging in published listings.
                  </p>
                </>
              ) : (
                <p className="text-2xs text-muted">
                  Needs a Google AI Studio key in Admin → Integrations → Gemini.
                  The sliders and cut-out below work without it.
                </p>
              )}
              <button onClick={cutOut} className="btn-secondary btn-sm w-full">
                <Wand2 className="h-3.5 w-3.5" /> Remove flat background
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card flex flex-col items-center gap-4 p-4">
        {current ? (
          <>
            <div className="w-full overflow-hidden rounded-lg bg-[repeating-conic-gradient(#e2e8f0_0_25%,transparent_0_50%)] bg-[length:16px_16px] dark:bg-[repeating-conic-gradient(#334155_0_25%,transparent_0_50%)]">
              <canvas ref={canvasRef} className="block h-auto w-full" />
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={download} className="btn-primary btn-sm">
                <Download className="h-3.5 w-3.5" /> Download
              </button>
              <button onClick={() => void saveToRecord()} disabled={busy || !property} className="btn-secondary btn-sm">
                Save to the property
              </button>
            </div>
          </>
        ) : (
          <EmptyState icon={<Sparkles className="h-10 w-10" />} title="Choose or upload a photo" />
        )}
      </div>
    </div>
  );
}
