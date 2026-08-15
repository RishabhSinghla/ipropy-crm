import type { JSX } from 'react';
/**
 * Site capture — the screen used standing at the gate of a builder floor.
 *
 * Everything here is shaped by where it is used: outdoors, one-handed, in
 * sunlight, with a signal that may not exist, immediately before walking in and
 * photographing the place. That makes the priorities different from every other
 * screen in this CRM.
 *
 *   It never waits for the network. The tap writes to IndexedDB and returns —
 *   see lib/captureQueue. A visit lost to no signal is a visit whose photos are
 *   unattributable that evening, which is the whole problem being solved.
 *
 *   It never waits for GPS. A fix under a concrete slab can take twenty seconds
 *   or never arrive, and the location is a nice-to-have — the property's
 *   identity comes from the person, not the coordinates. So it is collected in
 *   the background and attached if it turns up in time.
 *
 *   Finish is explicit because it gives the person a clean psychological end
 *   to one property and an exact photo window. The old automatic safeguards
 *   remain: the next Start and the stale-session sweep still close anything
 *   somebody forgets.
 *
 * The fields come from the module's own quick-create layout, so which ones
 * appear here is an admin setting in the Layout Designer rather than something
 * that needs a developer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { FieldMeta, ModuleMeta } from '@ipropy/shared';
import {
  Building2, Camera, Check, CheckCircle2, ChevronDown, ChevronRight, Clock,
  CloudOff, FolderOpen, Images, MapPin, Mic, RefreshCw, Trash2, Upload, Wifi,
} from 'lucide-react';
import { api, type CaptureSessionRow } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { FieldInput } from '../components/FieldRenderer';
import {
  discardQueued, enqueueFinish, enqueueVisit, flushQueue, listQueued, onQueueChange,
  startCaptureSync, type QueuedItem,
} from '../lib/captureQueue';
import { EmptyState, Skeleton, Spinner } from '../components/ui';

const CAPTURE_MODULE = 'properties';

/**
 * How long to wait for a location before starting without one.
 *
 * Short on purpose. The tap has to feel instant, and a visit with no
 * coordinates is barely worse than one with coordinates — location is used for
 * grouping and review, never to decide which property this is.
 */
const GPS_TIMEOUT_MS = 6000;

/**
 * How many fields are visible before "Add more details".
 *
 * The quick-create layout is shared with the desk, where nine fields is
 * reasonable. At a gate it is not: nine fields times ten properties is ninety
 * entries standing in the sun, which is the manual labour this was supposed to
 * remove rather than relocate. So the rest fold away, and Start is reachable
 * without scrolling past any of them.
 *
 * The remaining fields are still here, one tap away, because sometimes the
 * owner is standing there answering questions and it is easier to record it now
 * than to remember it tonight.
 */
const DEFAULT_PRIMARY_FIELD_COUNT = 4;

interface CapturePanelConfig {
  primaryFieldCount?: number;
  voiceEnabled?: boolean;
  gpsEnabled?: boolean;
  defaultMode?: 'site' | 'office';
}

interface ActiveCapture {
  clientRef: string;
  label: string;
  startedAt: string;
  mode: 'site' | 'office';
  /** Arrives once the offline visit reaches the server. */
  recordId?: string;
}

const ACTIVE_CAPTURE_KEY = 'ipropy-active-capture';

function loadActiveCapture(): ActiveCapture | null {
  try {
    const value = localStorage.getItem(ACTIVE_CAPTURE_KEY);
    return value ? JSON.parse(value) as ActiveCapture : null;
  } catch {
    return null;
  }
}

function rememberActiveCapture(value: ActiveCapture | null): void {
  try {
    if (value) localStorage.setItem(ACTIVE_CAPTURE_KEY, JSON.stringify(value));
    else localStorage.removeItem(ACTIVE_CAPTURE_KEY);
  } catch {
    // Private browsing can deny localStorage. IndexedDB still owns the durable
    // requests; this only restores the in-progress card after a page reload.
  }
}

/**
 * Container the browser will actually record into.
 *
 * Safari records mp4 and nothing else; Chrome and Firefox record webm. Asking
 * for an unsupported type does not fail loudly — `MediaRecorder` silently
 * substitutes its own, and the file lands with an extension that does not match
 * its contents, which the transcription provider then rejects. So the type is
 * chosen and the extension derived from it.
 */
function pickAudioFormat(): { mimeType?: string; ext: string } {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const mimeType of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(mimeType)) {
      return { mimeType, ext: mimeType.startsWith('audio/mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm' };
    }
  }
  return { ext: 'm4a' };
}

type RecordState = 'idle' | 'recording' | 'ready' | 'denied' | 'unsupported';

/**
 * Tap to start, tap to stop — not hold-to-talk.
 *
 * WhatsApp's hold gesture is the familiar one, but twenty seconds of holding
 * while walking towards a gate one-handed is how recordings get cut off at
 * "B-110 Greenfi". A tap with an obvious running timer is unambiguous and
 * survives being interrupted.
 */
function useRecorder(): {
  state: RecordState; seconds: number; clip: { blob: Blob; name: string } | null;
  start: () => Promise<void>; stop: () => void; discard: () => void;
} {
  const [state, setState] = useState<RecordState>(
    () => (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices ? 'unsupported' : 'idle'),
  );
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; name: string } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopTimer = (): void => {
    if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
  };

  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const { mimeType, ext } = pickAudioFormat();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        // Releasing the track matters: iOS leaves the orange recording dot lit
        // and holds the microphone against other apps until every track ends.
        stream.getTracks().forEach((t) => t.stop());
        setClip({ blob: new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/mp4' }), name: `note.${ext}` });
        setState('ready');
      };
      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setState('recording');
      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setState('denied');
    }
  };

  const stop = (): void => {
    stopTimer();
    recorderRef.current?.stop();
    recorderRef.current = null;
  };

  const discard = (): void => { setClip(null); setSeconds(0); setState('idle'); };

  useEffect(() => () => { stopTimer(); recorderRef.current?.stop(); }, []);

  return { state, seconds, clip, start, stop, discard };
}

interface Fix { lat: number; lng: number; accuracy?: number }

/** Ask only when the user opts in, and never block capture on the answer. */
function useLocation(enabled: boolean): { fix: Fix | null; state: 'idle' | 'locating' | 'ready' | 'denied' } {
  const [fix, setFix] = useState<Fix | null>(null);
  const [state, setState] = useState<'idle' | 'locating' | 'ready' | 'denied'>('idle');

  useEffect(() => {
    if (!enabled || !navigator.geolocation) {
      setFix(null);
      setState('idle');
      return;
    }
    setState('locating');
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        setFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setState('ready');
      },
      () => setState('denied'),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [enabled]);

  return { fix, state };
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/** The IndexedDB queue, as React state. */
function useQueue(): { queued: QueuedItem[]; reload: () => void } {
  const [queued, setQueued] = useState<QueuedItem[]>([]);
  const reload = (): void => { void listQueued().then(setQueued); };
  useEffect(() => {
    reload();
    return onQueueChange(reload);
  }, []);
  return { queued, reload };
}

export default function CapturePage(): JSX.Element {
  const queryClient = useQueryClient();
  const online = useOnline();
  const { queued } = useQueue();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [active, setActive] = useState<ActiveCapture | null>(() => loadActiveCapture());
  const [justFinished, setJustFinished] = useState<string | null>(null);
  const [modeOverride, setModeOverride] = useState<'site' | 'office' | null>(null);
  const [useGps, setUseGps] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const recorder = useRecorder();
  const nameRef = useRef<HTMLDivElement>(null);

  useEffect(() => { startCaptureSync(); }, []);

  const { data: module } = useQuery({
    queryKey: ['describe', CAPTURE_MODULE],
    queryFn: () => api.module(CAPTURE_MODULE),
    staleTime: 5 * 60_000,
  });

  // The quick-create layout decides which fields appear. Admin-editable in the
  // Layout Designer, so tuning this screen over the first few weeks of real use
  // needs nobody's help.
  const { data: layout } = useQuery({
    queryKey: ['layout', CAPTURE_MODULE, 'quick_create'],
    queryFn: () => api.layout(CAPTURE_MODULE, 'quick_create'),
    retry: false,
    staleTime: 5 * 60_000,
  });

  const panel = ((layout?.config as { capture?: CapturePanelConfig } | undefined)?.capture ?? {});
  const mode = modeOverride ?? (panel.defaultMode === 'office' ? 'office' : 'site');
  const gpsAvailable = panel.gpsEnabled !== false;
  const { fix, state: gpsState } = useLocation(mode === 'site' && gpsAvailable && useGps);

  const fields: FieldMeta[] = useMemo(() => {
    const meta = module as (ModuleMeta | undefined);
    if (!meta) return [];
    const byName = new Map(meta.fields.map((f) => [f.name, f]));
    const configured = (layout?.config as { blocks?: { fields: string[] }[] } | undefined)?.blocks
      ?.flatMap((b) => b.fields) ?? [];
    const chosen = configured.length
      ? configured
      : meta.fields.filter((f) => f.quickCreate).map((f) => f.name);
    // A property cannot be created without its label. Keep the screen usable if
    // an admin accidentally removes it from quick create; everything else is
    // exactly the order configured in Layout Designer.
    const labelField = meta.labelFields?.[0];
    const ordered = labelField && !chosen.includes(labelField) ? [labelField, ...chosen] : chosen;
    return ordered
      .map((n) => byName.get(n))
      .filter((f): f is FieldMeta => Boolean(f) && f!.displayType !== 'hidden' && f!.uitype !== 'autonumber');
  }, [module, layout]);

  const { data: sessions, isLoading: sessionsLoading } = useQuery({
    queryKey: ['capture', 'sessions'],
    queryFn: () => api.captureSessions(15),
    // The list is a comfort blanket, not a source of truth — a queued visit is
    // already shown locally, so a stale server list is harmless.
    staleTime: 30_000,
    retry: false,
  });

  const storageQuery = useQuery({
    queryKey: ['capture', 'storage', active?.clientRef],
    queryFn: () => api.captureStorage(active!.clientRef),
    enabled: Boolean(active && online),
    retry: false,
    refetchInterval: active ? 3000 : false,
  });

  useEffect(() => {
    const recordId = storageQuery.data?.recordId;
    if (!recordId || !active || active.recordId === recordId) return;
    const next = { ...active, recordId };
    setActive(next);
    rememberActiveCapture(next);
  }, [storageQuery.data?.recordId, active]);

  // Visits that have finished collecting and have something waiting to be said
  // back — the evening's work, counted during the day.
  const toReview = (sessions ?? []).filter(
    (s) => s.status === 'ready' && (s.transcript || s.voiceStatus !== 'none'),
  ).length;

  // Shoots the clock grouped on its own that still have no property. Counted
  // here so somebody who never taps Start still has a reason to open this
  // screen — otherwise the whole automatic path would be invisible to them.
  const { data: unnamedShoots } = useQuery({
    queryKey: ['capture', 'shoots', 'unnamed'],
    queryFn: () => api.unnamedShoots(50),
    staleTime: 30_000,
    retry: false,
  });
  const unnamed = unnamedShoots?.length ?? 0;

  const configuredPrimary = Number(panel.primaryFieldCount);
  const primaryCount = Number.isFinite(configuredPrimary)
    ? Math.max(1, Math.min(fields.length, Math.round(configuredPrimary)))
    : DEFAULT_PRIMARY_FIELD_COUNT;
  const primary = fields.slice(0, primaryCount);
  const secondary = fields.slice(primaryCount);

  const labelField = (module as ModuleMeta | undefined)?.labelFields?.[0] ?? 'name';
  const label = String(values[labelField] ?? '').trim();
  const canStart = label.length > 0 && !saving && !active;

  const uploadMedia = async (files: FileList | null): Promise<void> => {
    const recordId = storageQuery.data?.recordId ?? active?.recordId;
    if (!files?.length || !recordId || uploading) return;
    setUploading(true);
    let sent = 0;
    try {
      for (const file of Array.from(files)) {
        await api.uploadFile(file, recordId, CAPTURE_MODULE, storageQuery.data?.sessionId);
        sent += 1;
        setUploadedCount((count) => count + 1);
      }
      toast.success(`${sent} file${sent === 1 ? '' : 's'} added`, 'Originals are safe; processing continues automatically.');
    } catch (err) {
      toast.error('Upload stopped', `${sent} saved. ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!canStart) return;
    setSaving(true);
    try {
      const clientRef = crypto.randomUUID();
      await enqueueVisit(clientRef, {
        clientRef,
        startedAt: new Date().toISOString(),
        ...(fix ? { location: { lat: fix.lat, lng: fix.lng, ...(fix.accuracy ? { accuracy: fix.accuracy } : {}) } } : {}),
        property: { module: CAPTURE_MODULE, values },
        deviceLabel: navigator.userAgent.includes('iPhone') ? 'iPhone' : undefined,
      }, label, recorder.clip ?? undefined);

      const next: ActiveCapture = {
        clientRef,
        label,
        startedAt: new Date().toISOString(),
        mode,
      };
      setActive(next);
      rememberActiveCapture(next);
      setValues({});
      recorder.discard();
      // The list only matters once something has actually reached the server.
      void queryClient.invalidateQueries({ queryKey: ['capture', 'sessions'] });
    } catch (err) {
      // enqueueVisit only fails if IndexedDB itself is unavailable — private
      // mode, or storage full. Worth saying out loud rather than looking like
      // the tap did nothing.
      toast.error('Could not save this visit', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const finish = async (): Promise<void> => {
    if (!active || finishing) return;
    setFinishing(true);
    try {
      await enqueueFinish(active.clientRef, active.label, new Date().toISOString());
      const finishedLabel = active.label;
      setActive(null);
      rememberActiveCapture(null);
      setJustFinished(finishedLabel);
      setUploadedCount(0);
      setExpanded(false);
      window.setTimeout(() => setJustFinished(null), 5000);
      // Try immediately when online; the queue remains the source of truth if
      // this fails, and will retry on focus/online/timer as before.
      void flushQueue().finally(() => {
        void queryClient.invalidateQueries({ queryKey: ['capture', 'sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['capture', 'shoots'] });
      });
      window.setTimeout(() => nameRef.current?.querySelector('input')?.focus(), 50);
    } catch (err) {
      toast.error('Could not save Finish', (err as Error).message);
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-24 sm:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Property capture</h1>
          <p className="text-sm text-muted">Name it once, shoot, then finish.</p>
        </div>
        <StatusPill
          online={online}
          gps={mode === 'site' && useGps ? gpsState : null}
          pending={queued.length}
        />
      </header>

      {justFinished ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <Check className="h-4 w-4 shrink-0" />
          <span><strong>{justFinished}</strong> finished and is safe. You can start the next property.</span>
        </div>
      ) : null}

      {!active ? (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Where are you adding this property from?">
          <button
            type="button"
            onClick={() => setModeOverride('site')}
            className={cn(
              'rounded-xl border p-3 text-left transition-colors',
              mode === 'site'
                ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200'
                : 'border-slate-200 bg-white text-muted dark:border-slate-800 dark:bg-slate-900',
            )}
          >
            <MapPin className="mb-1 h-4 w-4" />
            <span className="block text-sm font-semibold">At property</span>
            <span className="block text-2xs opacity-80">Capture while visiting</span>
          </button>
          <button
            type="button"
            onClick={() => { setModeOverride('office'); setUseGps(false); }}
            className={cn(
              'rounded-xl border p-3 text-left transition-colors',
              mode === 'office'
                ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950/40 dark:text-brand-200'
                : 'border-slate-200 bg-white text-muted dark:border-slate-800 dark:bg-slate-900',
            )}
          >
            <Building2 className="mb-1 h-4 w-4" />
            <span className="block text-sm font-semibold">From office</span>
            <span className="block text-2xs opacity-80">Add or upload later</span>
          </button>
        </div>
      ) : null}

      {active ? (
        <div className="card overflow-hidden border-emerald-200 dark:border-emerald-900">
          <div className="flex items-start gap-3 bg-emerald-50 p-4 dark:bg-emerald-950/30">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              <Camera className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Capture in progress</p>
              <p className="truncate text-base font-semibold text-emerald-950 dark:text-emerald-100">{active.label}</p>
              <p className="mt-1 text-xs text-emerald-800/80 dark:text-emerald-200/80">
                Take the property photos and videos normally. Tap Finish when you are done.
              </p>
            </div>
          </div>
          <div className="space-y-3 border-t border-emerald-100 p-4 dark:border-emerald-900/60">
            {storageQuery.data?.recordId || active.recordId ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label className={cn('btn-primary cursor-pointer justify-center', uploading && 'pointer-events-none opacity-50')}>
                    <Camera className="h-4 w-4" /> Take photo
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={uploading}
                      onChange={(event) => { void uploadMedia(event.target.files); event.target.value = ''; }}
                    />
                  </label>
                  <label className={cn('btn-secondary cursor-pointer justify-center', uploading && 'pointer-events-none opacity-50')}>
                    {uploading ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />} Add media
                    <input
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      className="hidden"
                      disabled={uploading}
                      onChange={(event) => { void uploadMedia(event.target.files); event.target.value = ''; }}
                    />
                  </label>
                </div>
                <p className="text-center text-xs text-muted">
                  {uploading ? 'Uploading originals… keep this screen open.' : `${uploadedCount} added from this screen. Originals are never changed.`}
                </p>
                {storageQuery.data?.storage?.externalUrl ? (
                  <a
                    href={storageQuery.data.storage.externalUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center justify-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
                  >
                    <FolderOpen className="h-4 w-4" /> Open this property in OneDrive
                  </a>
                ) : storageQuery.data?.storage?.status === 'failed' ? (
                  <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    Cloud folder needs attention, but direct uploads still work. {storageQuery.data.storage.lastError}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="flex items-center justify-center gap-2 text-xs text-muted">
                {online ? <Spinner className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}
                {online
                  ? 'Creating the property and its media folder…'
                  : 'No signal: use the phone camera now; add the files here when the connection returns.'}
              </p>
            )}
          </div>
        </div>
      ) : (
      <div className="card space-y-3 p-4">
        {!module ? (
          <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : (
          <>
            {primary.map((field) => (
              <div key={field.name} ref={field.name === labelField ? nameRef : undefined}>
                <label className="mb-1 block text-xs font-medium text-muted">{field.label}</label>
                <FieldInput
                  field={field}
                  value={values[field.name]}
                  formValues={values}
                  onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
                  onChangeOther={(name, v) => setValues((prev) => ({ ...prev, [name]: v }))}
                />
              </div>
            ))}

            {panel.voiceEnabled !== false ? <VoiceNote recorder={recorder} /> : null}

            {mode === 'site' && gpsAvailable ? (
              <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-sm dark:border-slate-700">
                <span>
                  <span className="block font-medium">Add current location</span>
                  <span className="block text-xs text-muted">Optional — property capture works without GPS.</span>
                </span>
                <input
                  type="checkbox"
                  checked={useGps}
                  onChange={(e) => setUseGps(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
              </label>
            ) : null}

            {secondary.length ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center justify-center gap-1 py-1 text-xs font-medium text-muted hover:text-slate-700 dark:hover:text-slate-200"
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
                {expanded ? 'Hide extra details' : `Add more details (${secondary.length})`}
              </button>
            ) : null}

            {expanded ? secondary.map((field) => (
              <div key={field.name}>
                <label className="mb-1 block text-xs font-medium text-muted">{field.label}</label>
                <FieldInput
                  field={field}
                  value={values[field.name]}
                  formValues={values}
                  onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
                  onChangeOther={(name, v) => setValues((prev) => ({ ...prev, [name]: v }))}
                />
              </div>
            )) : null}
          </>
        )}
      </div>
      )}

      {/*
        Pinned rather than sitting under the form. With the extra details open
        the fields run past the fold, and the one control that must never need
        hunting for — at a gate, one-handed — is this one.
      */}
      <div className="sticky bottom-0 rounded-t-xl border-t border-slate-200 bg-white/95 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <button
          type="button"
          onClick={() => { if (active) void finish(); else void start(); }}
          disabled={active ? finishing || uploading : !canStart}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-lg py-4 text-base font-semibold text-white disabled:opacity-40',
            active ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-brand-600 hover:bg-brand-700',
          )}
        >
          {saving || finishing ? <Spinner /> : active ? <CheckCircle2 className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
          {active ? 'Finish property' : mode === 'site' ? 'Start capture' : 'Create property'}
        </button>
        <p className="mt-1.5 text-center text-xs text-muted">
          {active
            ? 'Finish closes this property cleanly. Automatic safeguards still protect forgotten visits.'
            : online ? 'Saved here first, then synced.' : 'No signal — saved on this phone and sent later.'}
        </p>
      </div>

      {queued.length ? <QueuedList items={queued} online={online} /> : null}

      {/*
        Surfaced here rather than only in the menu: the person who spoke the
        notes is the person who has to confirm them, and the count is the only
        thing that makes an evening task visible during the day.
      */}
      {toReview > 0 ? (
        <Link
          to="/capture/review"
          className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm font-medium text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200"
        >
          <Check className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {toReview} visit{toReview === 1 ? '' : 's'} to confirm
          </span>
          <ChevronRight className="h-4 w-4" />
        </Link>
      ) : null}

      {/* Photos shot without anyone tapping Start. Deliberately prominent and
          phrased as a normal outcome rather than an error — forgetting the tap
          is the expected case this exists to absorb, and a screen that scolded
          somebody for it would just teach them to dread the app. */}
      {unnamed > 0 ? (
        <Link
          to="/capture/shoots"
          className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <Images className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {unnamed} {unnamed === 1 ? 'shoot needs' : 'shoots need'} a property
          </span>
          <ChevronRight className="h-4 w-4" />
        </Link>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted">Recent visits</h2>
        {sessionsLoading ? (
          <Skeleton className="h-16" />
        ) : !sessions?.length ? (
          <EmptyState icon={<Clock className="h-8 w-8" />} title="No visits yet" body="Your site visits will appear here." />
        ) : (
          <ul className="card divide-y divide-slate-100 dark:divide-slate-800">
            {sessions.map((s) => <SessionRow key={s.id} session={s} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Say it instead of typing it.
 *
 * The single biggest usability win available on this screen. Everything in a
 * spoken note — price, size, configuration, facing, the owner's name — is
 * already a field, and for somebody quick on a phone call and slow on a phone
 * keyboard, twenty seconds of talking replaces nine dropdowns and four number
 * pads standing in the sun.
 *
 * Optional on purpose. A noisy site, or the owner standing right there
 * listening, are both good reasons to type instead.
 */
function VoiceNote({ recorder }: { recorder: ReturnType<typeof useRecorder> }): JSX.Element | null {
  const { state, seconds, clip, start, stop, discard } = recorder;
  if (state === 'unsupported') return null;

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  if (state === 'denied') {
    return (
      <p className="rounded-lg bg-slate-100 p-2.5 text-xs text-muted dark:bg-slate-800">
        Microphone is blocked for this site, so notes have to be typed. Turn it on in your
        browser&apos;s settings for this page if you want to speak them instead.
      </p>
    );
  }

  if (state === 'recording') {
    return (
      <button
        type="button"
        onClick={stop}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 py-3 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
      >
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />
        Recording {mmss} — tap to stop
      </button>
    );
  }

  if (state === 'ready' && clip) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 dark:border-emerald-900 dark:bg-emerald-950/40">
        <Check className="h-4 w-4 shrink-0 text-emerald-600" />
        <span className="flex-1 text-sm text-emerald-800 dark:text-emerald-200">Note recorded ({mmss})</span>
        {/* Playable before it is sent — the only chance to notice it caught nothing. */}
        <audio controls src={URL.createObjectURL(clip.blob)} className="h-8 max-w-[9rem]" />
        <button type="button" onClick={discard} title="Discard the note" className="rounded p-1 text-slate-400 hover:text-red-600">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => { void start(); }}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 py-3 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <Mic className="h-4 w-4" />
      Say the details instead
    </button>
  );
}

function StatusPill(
  { online, gps, pending }: { online: boolean; gps: string | null; pending: number },
): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs">
      {pending > 0 ? (
        <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          <Clock className="h-3 w-3" />
          {pending} waiting
        </span>
      ) : null}
      <span
        className={cn(
          'flex items-center gap-1 rounded-full px-2 py-1',
          online
            ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
            : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
        )}
      >
        {online ? <Wifi className="h-3 w-3" /> : <CloudOff className="h-3 w-3" />}
        {online ? 'Online' : 'Offline'}
      </span>
      {gps ? (
        <span
          title={gps === 'denied' ? 'Location permission is off — visits will save without coordinates' : undefined}
          className={cn(
            'flex items-center gap-1 rounded-full px-2 py-1',
            gps === 'ready'
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200'
              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
          )}
        >
          <MapPin className="h-3 w-3" />
          {gps === 'ready' ? 'Located' : gps === 'denied' ? 'No location' : 'Locating'}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Visits still on the phone.
 *
 * Shown rather than hidden: somebody who has just captured six properties with
 * no signal needs to see that all six are safe, or they will capture them again
 * on paper.
 */
function QueuedList({ items, online }: { items: QueuedItem[]; online: boolean }): JSX.Element {
  const [syncing, setSyncing] = useState(false);
  const sync = async (): Promise<void> => {
    setSyncing(true);
    try {
      const { sent, remaining } = await flushQueue();
      if (sent) toast.success(`${sent} visit${sent === 1 ? '' : 's'} synced`, remaining ? `${remaining} still waiting` : undefined);
      else if (remaining) toast.error('Could not sync yet', 'Will keep trying in the background.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted">On this phone</h2>
        <button type="button" className="btn-secondary btn-sm" onClick={() => { void sync(); }} disabled={!online || syncing}>
          {syncing ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
          Sync now
        </button>
      </div>
      <ul className="card divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((item) => (
          <li key={item.clientRef} className="flex items-center gap-3 p-3">
            <Clock className="h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.label}</p>
              <p className="truncate text-xs text-muted">
                {new Date(item.queuedAt).toLocaleTimeString()}
                {item.attempts > 0 ? ` · ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}` : ''}
                {item.lastError ? ` · ${item.lastError}` : ''}
              </p>
            </div>
            <button
              type="button"
              title="Discard this visit"
              className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
              onClick={() => { void discardQueued(item.clientRef); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SessionRow({ session }: { session: CaptureSessionRow }): JSX.Element {
  const started = new Date(session.startedAt);
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{session.recordLabel ?? 'Unassigned visit'}</p>
        <p className="text-xs text-muted">
          {started.toLocaleDateString()} {started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {' · '}
          {session.mediaCount} file{session.mediaCount === 1 ? '' : 's'}
        </p>
      </div>
      {session.endedAt === null ? (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200">
          In progress
        </span>
      ) : null}
    </>
  );

  return (
    <li>
      {session.recordId ? (
        <Link to={`/properties/${session.recordId}`} className="flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
          {body}
        </Link>
      ) : (
        <div className="flex items-center gap-3 p-3">{body}</div>
      )}
    </li>
  );
}
