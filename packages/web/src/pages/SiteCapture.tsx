/**
 * Adding a property while standing in front of it.
 *
 * There are two honest ways a unit gets into this CRM and they are not the same
 * job. At a desk you have a spreadsheet open, both hands free and no hurry, and
 * the full New Property form is right. At a gate you have one hand, a builder's
 * rep waiting, sunlight on the screen and about forty seconds before the moment
 * passes — and the desk form asked for nine fields across two columns, which is
 * how a visit ends with nothing recorded and a note to "add it tonight".
 *
 * So this screen is the same create, shaped for the other posture: one column,
 * four fields, a Save that never scrolls out of reach, and the rest folded away
 * for when the owner is standing there answering questions anyway.
 *
 * Two things it deliberately is NOT:
 *
 * - It is not a second way to store a property. It calls the same
 *   `POST /api/records/properties` as the desk form, so validation, workflows,
 *   assignment rules, duplicate detection and the audit trail all apply. A
 *   parallel intake path would be a second source of truth, and this codebase
 *   has paid for that lesson already.
 * - It is not a camera. Photos are not taken here. The property's OneDrive
 *   folder and the Finish button live on the record itself, and this screen's
 *   last act is to hand you straight to them.
 *
 * The field list comes from the module's quick-create layout, so which fields
 * appear at a gate is an admin decision in Layout Designer, not a constant in
 * this file.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { collectFieldErrors, type FieldMeta, type ModuleMeta } from '@ipropy/shared';
import { Check, ChevronDown, Images, MapPin, Plus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { startingValues } from '../lib/recordDefaults';
import { invalidateRecordQueries } from '../lib/invalidate';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { FieldInput } from '../components/FieldRenderer';
import { Spinner, Toggle } from '../components/ui';

const MODULE = 'properties';

/**
 * How many fields are visible before "More details", when an admin has not said.
 *
 * The quick-create layout is shared with the desk, where nine fields is
 * reasonable. At a gate it is not: nine fields times ten units is ninety
 * entries standing in the sun, which is the manual labour this was meant to
 * remove rather than relocate. The rest are one tap away, because sometimes the
 * owner is right there and it is easier to record it now than to remember it
 * tonight.
 *
 * Admin -> Layout Designer -> Properties -> Quick create overrides both this
 * and whether GPS is offered at all. Those two controls already existed and
 * were reading nothing after the old capture screen was removed, which is a
 * settings page that lies.
 */
const DEFAULT_PRIMARY_FIELD_COUNT = 4;

interface CapturePanelConfig {
  primaryFieldCount?: number;
  gpsEnabled?: boolean;
}

/** Long enough for a cold GPS fix, short enough that nobody thinks it hung. */
const GPS_TIMEOUT_MS = 8000;

/** Where a coordinate goes. Both are real decimal columns on the property. */
const LAT_FIELD = 'latitude';
const LNG_FIELD = 'longitude';

interface Fix { lat: number; lng: number; accuracy?: number }

/**
 * Ask only when the user opts in, and never block saving on the answer.
 *
 * `watchPosition` rather than `getCurrentPosition`: the first fix indoors or
 * between towers is often a 2km cell-tower guess that then tightens to a few
 * metres over the next several seconds. Watching means the number saved is the
 * best one available at the moment Save is pressed, not the first one offered.
 */
function useLocation(enabled: boolean): { fix: Fix | null; state: 'off' | 'locating' | 'ready' | 'denied' } {
  const [fix, setFix] = useState<Fix | null>(null);
  const [state, setState] = useState<'off' | 'locating' | 'ready' | 'denied'>('off');

  useEffect(() => {
    if (!enabled || !navigator.geolocation) {
      setFix(null);
      setState('off');
      return;
    }
    setState('locating');
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        setFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setState('ready');
      },
      // Denied, unavailable or timed out all land here. They are the same thing
      // to the person holding the phone: no coordinates, carry on without them.
      () => setState('denied'),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [enabled]);

  return { fix, state };
}

/** What was added on this phone, this session — proof the tap did something. */
interface Saved { id: string; label: string }

export default function SiteCapture(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [values, setValues] = useState<Record<string, unknown>>({});
  /**
   * Whatever the module says a new record starts with — a field's default, or
   * the option starred in Admin → Dropdowns. Applied once the module arrives
   * and only over an untouched form, so it can never overwrite typing.
   */
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [useGps, setUseGps] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Saved[]>([]);

  const { data: module, isLoading } = useQuery({
    queryKey: ['describe', MODULE],
    queryFn: () => api.module(MODULE),
    staleTime: 5 * 60_000,
  });

  // Admin-editable in Layout Designer. Falls back to the module's own
  // quick-create flags if no layout row exists.
  const { data: layout } = useQuery({
    queryKey: ['layout', MODULE, 'quick_create'],
    queryFn: () => api.layout(MODULE, 'quick_create'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!module || defaultsApplied) return;
    setDefaultsApplied(true);
    const defaults = startingValues(module as ModuleMeta);
    if (Object.keys(defaults).length) setValues((prev) => ({ ...defaults, ...prev }));
  }, [module, defaultsApplied]);

  const panel = ((layout?.config as { capture?: CapturePanelConfig } | undefined)?.capture
    ?? {}) as CapturePanelConfig;
  const gpsOffered = panel.gpsEnabled !== false;

  const { fix, state: gpsState } = useLocation(useGps && gpsOffered);

  const fields: FieldMeta[] = useMemo(() => {
    const meta = module as ModuleMeta | undefined;
    if (!meta) return [];
    const byName = new Map(meta.fields.map((f) => [f.name, f]));
    const configured = (layout?.config as { blocks?: { fields: string[] }[] } | undefined)?.blocks
      ?.flatMap((b) => b.fields) ?? [];
    const chosen = configured.length
      ? configured
      : meta.fields.filter((f) => f.quickCreate).map((f) => f.name);

    // A property cannot be created without its label. Keep this screen usable
    // if an admin removes it from quick create; everything else stays in
    // exactly the order Layout Designer configured.
    const labelField = meta.labelFields?.[0];
    const ordered = labelField && !chosen.includes(labelField) ? [labelField, ...chosen] : chosen;

    return ordered
      .map((n) => byName.get(n))
      .filter((f): f is FieldMeta => Boolean(f)
        && f!.displayType !== 'hidden'
        && f!.uitype !== 'autonumber'
        // The two coordinate fields are filled by the GPS control below. Showing
        // them as decimal boxes as well would invite somebody to type over a
        // reading they cannot check.
        && f!.name !== LAT_FIELD
        && f!.name !== LNG_FIELD);
  }, [module, layout]);

  // Clamped rather than trusted: a stale layout can name a count larger than the
  // field list, which would fold nothing away and quietly undo the whole point.
  const configured = Number(panel.primaryFieldCount);
  const primaryCount = Number.isFinite(configured) && fields.length
    ? Math.max(1, Math.min(fields.length, Math.round(configured)))
    : DEFAULT_PRIMARY_FIELD_COUNT;
  const primary = showAll ? fields : fields.slice(0, primaryCount);
  const hidden = Math.max(0, fields.length - primaryCount);

  const setValue = (name: string, value: unknown): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const labelField = (module as ModuleMeta | undefined)?.labelFields?.[0];
  const label = labelField ? String(values[labelField] ?? '').trim() : '';
  const canSave = Boolean(label) && !saving;

  const save = async (): Promise<void> => {
    if (!canSave || !module) return;

    // Validate against the same rules the server enforces, so a mandatory field
    // is caught here rather than as a 400 after the person has walked away.
    const found = collectFieldErrors(fields, values, values);
    if (found.length) {
      setErrors(Object.fromEntries(found.map((e) => [e.field, e.message])));
      // The offending field may be folded away.
      setShowAll(true);
      toast.error('Something is missing', 'The highlighted fields need a value before this can be saved.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...values,
        // Only when there is an actual reading. A property saved without a fix
        // must have no coordinates at all, never a zero — 0,0 is a real place
        // in the Gulf of Guinea and it plots there on every map.
        ...(fix ? { [LAT_FIELD]: fix.lat, [LNG_FIELD]: fix.lng } : {}),
      };
      const created = await api.create(MODULE, payload);
      const id = created.id;

      setSaved((prev) => [{ id, label: label || 'New property' }, ...prev].slice(0, 8));
      setValues({});
      setErrors({});
      setShowAll(false);
      invalidateRecordQueries(queryClient, MODULE);

      toast.success(
        `${label} saved`,
        fix
          ? 'Location recorded. Open it to add photos, or add the next one now.'
          : 'Open it to add photos, or add the next one now.',
      );
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error('Could not save it', message);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  return (
    // Capped narrow even on a laptop: this is a phone screen that happens to be
    // reachable from a desk, and a four-field form stretched to 1400px reads as
    // a broken page rather than a deliberate one.
    <div className="mx-auto w-full max-w-lg pb-28">
      <header className="pt-1">
        <h1 className="text-xl font-semibold tracking-tight">Add a property on site</h1>
        <p className="mt-1 text-sm text-muted">
          Fill in what you know standing there. You can finish the rest later from your desk.
        </p>
      </header>

      {gpsOffered && <GpsPanel enabled={useGps} onToggle={setUseGps} fix={fix} state={gpsState} />}

      <div className="mt-3 space-y-3">
        {primary.map((field) => (
          <div key={field.name}>
            <label htmlFor={`sc_${field.name}`} className="mb-1 block text-sm font-medium">
              {field.label}
              {field.isMandatory && <span className="ml-0.5 text-negative">*</span>}
            </label>
            <FieldInput
              id={`sc_${field.name}`}
              field={field}
              value={values[field.name]}
              onChange={(v) => setValue(field.name, v)}
              onChangeOther={setValue}
              error={errors[field.name]}
              formValues={values}
              moduleName={MODULE}
            />
            {errors[field.name] && (
              <p className="mt-1 text-xs text-negative">{errors[field.name]}</p>
            )}
          </div>
        ))}
      </div>

      {hidden > 0 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="btn-ghost mt-3 w-full justify-center gap-1.5 py-3 text-sm"
        >
          <ChevronDown className="h-4 w-4" />
          More details ({hidden})
        </button>
      )}

      {saved.length > 0 && <JustAdded saved={saved} onOpen={(id) => navigate(`/${MODULE}/${id}`)} />}

      {/*
        Fixed rather than in flow. On a phone the keyboard eats the lower half of
        the screen, and a Save that lives at the bottom of a nine-field form is a
        Save nobody finds with one thumb.
      */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 lg:left-60">
        <div className="mx-auto flex max-w-lg items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="btn-primary h-12 flex-1 justify-center gap-2 text-base"
          >
            {saving ? <Spinner className="h-4 w-4" /> : <Plus className="h-4.5 w-4.5" />}
            {saving ? 'Saving…' : 'Save property'}
          </button>
        </div>
        {!label && (
          <p className="mx-auto mt-1.5 max-w-lg text-center text-xs text-muted">
            Give it a name to save — the flat number is enough.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The location control.
 *
 * Optional and off-able on purpose. Coordinates are useful and are also the one
 * thing on this screen that costs battery, needs a permission prompt and can
 * fail silently indoors — so it says out loud what it is doing, including when
 * it is doing nothing.
 */
function GpsPanel({
  enabled, onToggle, fix, state,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  fix: Fix | null;
  state: 'off' | 'locating' | 'ready' | 'denied';
}): JSX.Element {
  const message = state === 'ready' && fix
    // Accuracy is shown because it is the difference between "this building"
    // and "this neighbourhood", and only the person standing there can judge
    // whether that is good enough to keep.
    ? `Locked on, accurate to about ${Math.round(fix.accuracy ?? 0)} m`
    : state === 'locating' ? 'Finding you… step outside if it takes a while'
      : state === 'denied' ? 'Your phone would not share location. The property will save without it.'
        : 'Off. The property will save without coordinates.';

  return (
    <div className={cn(
      'card mt-4 p-3',
      state === 'ready' && 'border-positive/40',
    )}
    >
      <div className="flex items-center gap-3">
        <MapPin className={cn(
          'h-5 w-5 shrink-0',
          state === 'ready' ? 'text-positive' : 'text-muted',
        )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Record this location</p>
          <p className="mt-0.5 text-xs text-muted">{message}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} ariaLabel="Record this location" />
      </div>
    </div>
  );
}

/** Added just now, on this phone — with the one thing you would do next. */
function JustAdded({ saved, onOpen }: { saved: Saved[]; onOpen: (id: string) => void }): JSX.Element {
  return (
    <div className="mt-6">
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted">
        Added just now
      </p>
      <div className="space-y-1.5">
        {saved.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpen(s.id)}
            className="card flex w-full items-center gap-2.5 p-3 text-left hover:border-brand-400"
          >
            <Check className="h-4 w-4 shrink-0 text-positive" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
              <Images className="h-3.5 w-3.5" /> Add photos
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
