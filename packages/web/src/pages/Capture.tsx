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
 *   There is no finish button, by design. Nobody presses one reliably after ten
 *   visits; the next Start closes the previous visit and the server closes the
 *   day's last one.
 *
 * The fields come from the module's own quick-create layout, so which ones
 * appear here is an admin setting in the Layout Designer rather than something
 * that needs a developer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { FieldMeta, ModuleMeta } from '@ipropy/shared';
import { Camera, Check, ChevronDown, Clock, CloudOff, MapPin, RefreshCw, Trash2, Wifi } from 'lucide-react';
import { api, type CaptureSessionRow } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { FieldInput } from '../components/FieldRenderer';
import {
  discardQueued, enqueueVisit, flushQueue, listQueued, onQueueChange,
  startCaptureSync, type QueuedVisit,
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
const PRIMARY_FIELD_COUNT = 4;

interface Fix { lat: number; lng: number; accuracy?: number }

/** Ask once, in the background, and never block on the answer. */
function useLocation(): { fix: Fix | null; state: 'idle' | 'locating' | 'ready' | 'denied' } {
  const [fix, setFix] = useState<Fix | null>(null);
  const [state, setState] = useState<'idle' | 'locating' | 'ready' | 'denied'>('idle');

  useEffect(() => {
    if (!navigator.geolocation) return;
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
  }, []);

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
function useQueue(): { queued: QueuedVisit[]; reload: () => void } {
  const [queued, setQueued] = useState<QueuedVisit[]>([]);
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
  const { fix, state: gpsState } = useLocation();
  const { queued } = useQueue();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
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

  const fields: FieldMeta[] = useMemo(() => {
    const meta = module as (ModuleMeta | undefined);
    if (!meta) return [];
    const byName = new Map(meta.fields.map((f) => [f.name, f]));
    const configured = (layout?.config as { blocks?: { fields: string[] }[] } | undefined)?.blocks
      ?.flatMap((b) => b.fields) ?? [];
    const chosen = configured.length
      ? configured
      : meta.fields.filter((f) => f.quickCreate).map((f) => f.name);
    return chosen
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

  const primary = fields.slice(0, PRIMARY_FIELD_COUNT);
  const secondary = fields.slice(PRIMARY_FIELD_COUNT);

  const labelField = (module as ModuleMeta | undefined)?.labelFields?.[0] ?? 'name';
  const label = String(values[labelField] ?? '').trim();
  const canStart = label.length > 0 && !saving;

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
      }, label);

      setJustSaved(label);
      setValues({});
      // The list only matters once something has actually reached the server.
      void queryClient.invalidateQueries({ queryKey: ['capture', 'sessions'] });
      window.setTimeout(() => setJustSaved(null), 4000);
      nameRef.current?.querySelector('input')?.focus();
    } catch (err) {
      // enqueueVisit only fails if IndexedDB itself is unavailable — private
      // mode, or storage full. Worth saying out loud rather than looking like
      // the tap did nothing.
      toast.error('Could not save this visit', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-24 sm:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Site capture</h1>
          <p className="text-sm text-muted">Start a visit, then shoot with the normal camera.</p>
        </div>
        <StatusPill online={online} gps={gpsState} pending={queued.length} />
      </header>

      {justSaved ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <Check className="h-4 w-4 shrink-0" />
          <span><strong>{justSaved}</strong> started. Shoot now — there is nothing to press when you finish.</span>
        </div>
      ) : null}

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

      {/*
        Pinned rather than sitting under the form. With the extra details open
        the fields run past the fold, and the one control that must never need
        hunting for — at a gate, one-handed — is this one.
      */}
      <div className="sticky bottom-0 rounded-t-xl border-t border-slate-200 bg-white/95 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <button
          type="button"
          onClick={() => { void start(); }}
          disabled={!canStart}
          className="btn-primary flex w-full items-center justify-center gap-2 py-4 text-base disabled:opacity-40"
        >
          {saving ? <Spinner /> : <Camera className="h-5 w-5" />}
          Start shoot
        </button>
        <p className="mt-1.5 text-center text-xs text-muted">
          {online ? 'Saved here first, then synced.' : 'No signal — saved on this phone and sent later.'}
        </p>
      </div>

      {queued.length ? <QueuedList items={queued} online={online} /> : null}

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

function StatusPill(
  { online, gps, pending }: { online: boolean; gps: string; pending: number },
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
function QueuedList({ items, online }: { items: QueuedVisit[]; online: boolean }): JSX.Element {
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
