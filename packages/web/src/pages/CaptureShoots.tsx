/**
 * Naming the day's shoots — the screen that replaces having to remember.
 *
 * The gate tap was the weak link: it works perfectly and only if somebody does
 * it, ten times a day, in the sun, while an owner talks at them. Miss one and
 * that visit's photos land nowhere. So the tap is optional now, and this is
 * where a day with no taps at all gets sorted out: the clock has already
 * grouped the photos into the places they were shot (server/core/capture/
 * grouping.ts), and the only thing missing from each group is the one fact a
 * clock can never supply — which property it is.
 *
 * Two rules shape the whole screen.
 *
 * **Show the photos.** Nobody can tell "9:03–9:21, 12 photos" from
 * "9:48–10:04, 14 photos" — but everybody recognises their own pictures
 * instantly. The thumbnails are not decoration, they are the entire mechanism
 * by which somebody knows which property they are looking at.
 *
 * **One box that both finds and creates.** A floor photographed this morning
 * usually is not in the CRM yet, so "search" and "add new" are the same action
 * as far as the user is concerned. Making them different — find it, fail, leave,
 * create it, come back — would put back exactly the friction this removes.
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Camera, Check, ChevronRight, ImageOff, MapPin, Plus, Search } from 'lucide-react';
import { api, authedFileUrl, type UnnamedShoot } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { EmptyState, Skeleton, Spinner } from '../components/ui';

const CAPTURE_MODULE = 'properties';

/**
 * "9:03 am – 9:21 am" — the shape of the visit, in the language of a clock face.
 *
 * Pinned to en-IN rather than the browser's locale, as Dashboard and Inbox
 * already do. A laptop left on en-GB renders 16:15, and this is the one number
 * on the screen somebody matches against their own memory of the afternoon.
 */
function window_(startedAt: string, endedAt: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const start = new Date(startedAt);
  const label = start.toLocaleTimeString('en-IN', opts);
  if (!endedAt) return label;
  const end = new Date(endedAt);
  if (end.getTime() - start.getTime() < 60_000) return label;
  return `${label} – ${end.toLocaleTimeString('en-IN', opts)}`;
}

/** "Today" / "Yesterday" / a date — a day's shoots are reviewed as a day. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
}

export default function CaptureShootsPage(): JSX.Element {
  const { data: shoots, isLoading } = useQuery({
    queryKey: ['capture', 'shoots', 'unnamed'],
    queryFn: () => api.unnamedShoots(50),
    retry: false,
  });

  // Grouped by day so a backlog reads as "Today: 6, Yesterday: 2" rather than
  // one undifferentiated list somebody has to date-check their way down.
  const byDay = useMemo(() => {
    const groups = new Map<string, UnnamedShoot[]>();
    for (const shoot of shoots ?? []) {
      const key = dayLabel(shoot.startedAt);
      const list = groups.get(key);
      if (list) list.push(shoot);
      else groups.set(key, [shoot]);
    }
    return [...groups];
  }, [shoots]);

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 pb-24 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">Name today&apos;s shoots</h1>
        <p className="text-sm text-muted">
          Your photos grouped themselves by when you took them. Tell each group which property it is.
        </p>
      </header>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : !byDay.length ? (
        <EmptyState
          icon={<Check className="h-8 w-8" />}
          title="Everything is named"
          body="Photos you shoot get grouped automatically. Any group that still needs a property will show up here — usually within half an hour of uploading."
        />
      ) : (
        byDay.map(([day, group]) => (
          <section key={day} className="space-y-3">
            <h2 className="text-sm font-medium text-muted">
              {day} · {group.length} {group.length === 1 ? 'shoot' : 'shoots'}
            </h2>
            {group.map((shoot) => <ShootCard key={shoot.id} shoot={shoot} />)}
          </section>
        ))
      )}

      <p className="pt-2 text-center text-sm text-muted">
        <Link to="/capture" className="inline-flex items-center gap-1 hover:text-fg">
          <Camera className="h-4 w-4" /> Start a visit at the gate instead
          <ChevronRight className="h-4 w-4" />
        </Link>
      </p>
    </div>
  );
}

function ShootCard({ shoot }: { shoot: UnnamedShoot }): JSX.Element {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typed = query.trim();

  const { data: matches, isFetching } = useQuery({
    queryKey: ['lookup', CAPTURE_MODULE, typed],
    queryFn: () => api.lookup(CAPTURE_MODULE, typed),
    // Two characters is where a search stops returning most of the database.
    enabled: typed.length >= 2 && !chosen,
    staleTime: 30_000,
    retry: false,
  });

  const name = useMutation({
    mutationFn: (body: { recordId: string } | { property: { module: string; values: Record<string, unknown> } }) =>
      api.nameShoot(shoot.id, body),
    onSuccess: (result) => {
      toast.success(
        'Filed',
        `${result.photosAttached} ${result.photosAttached === 1 ? 'photo is' : 'photos are'} now on this property.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['capture', 'shoots', 'unnamed'] });
      void queryClient.invalidateQueries({ queryKey: ['capture', 'sessions'] });
    },
    onError: (err: Error) => toast.error('Could not file these photos', err.message),
  });

  const existing = matches ?? [];

  const extraFeatures = useMemo(() => {
    const summary = (shoot.summary ?? '').toLowerCase();
    return shoot.features.filter((f) => !summary.includes(f.toLowerCase()));
  }, [shoot.summary, shoot.features]);

  // Offered whenever what was typed is not already an exact match — the usual
  // case for a floor photographed this morning.
  const canCreate = typed.length >= 2
    && !existing.some((m) => m.label.toLowerCase() === typed.toLowerCase());

  return (
    <div className="card space-y-3 p-3">
      <PreviewStrip shoot={shoot} />

      {/* What the photos are of, when a model has looked. This is the line that
          turns naming a three-day-old shoot from a memory test into reading —
          so it sits above the count, not below it. Absent on an install with no
          AI provider, and the card is designed to read fine that way. */}
      {shoot.summary && (
        <p className="text-sm font-medium leading-snug">{shoot.summary}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className={cn(shoot.summary ? 'text-muted' : 'font-medium')}>
          {shoot.mediaCount} {shoot.mediaCount === 1 ? 'photo' : 'photos'}
        </span>
        <span className="text-muted">{window_(shoot.startedAt, shoot.endedAt)}</span>
        {shoot.lat !== null && shoot.lng !== null && (
          <a
            href={`https://www.google.com/maps?q=${shoot.lat},${shoot.lng}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted hover:text-fg"
          >
            <MapPin className="h-3.5 w-3.5" /> Map
          </a>
        )}
      </div>

      {/* Only what the summary did not already say. The model writes both, and
          it naturally repeats itself — "marble flooring, modular kitchen" in
          the line above and again as chips is noise on a phone, and noise is
          what somebody skims past. */}
      {extraFeatures.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {extraFeatures.map((feature) => (
            <li
              key={feature}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-muted dark:border-slate-700"
            >
              {feature}
            </li>
          ))}
        </ul>
      )}

      {/* What was said at the gate, when there was a recording. Not a name, but
          often the fastest reminder of which place this was. */}
      {shoot.transcript && (
        <p className="rounded-md bg-subtle px-3 py-2 text-sm text-muted">
          &ldquo;{shoot.transcript.slice(0, 180)}{shoot.transcript.length > 180 ? '…' : ''}&rdquo;
        </p>
      )}

      {chosen ? (
        // Stacked, and the name is never truncated. This is the step where
        // somebody checks they picked the right one, and "Verdant Green…"
        // cannot be told apart from any of the other thirty units in the
        // project — which is the mistake this step exists to catch.
        <div className="space-y-2">
          <p className="text-sm">
            {chosen.id === 'new' ? 'Create and file under' : 'File under'}{' '}
            <strong className="break-words">{chosen.label}</strong>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => { setChosen(null); setQuery(''); }}
              disabled={name.isPending}
            >
              Change
            </button>
            <button
              type="button"
              className="btn-primary btn-sm flex-1"
              disabled={name.isPending}
              onClick={() => name.mutate(
                chosen.id === 'new'
                  ? { property: { module: CAPTURE_MODULE, values: { name: chosen.label } } }
                  : { recordId: chosen.id },
              )}
            >
              {name.isPending
                ? <Spinner className="h-4 w-4" />
                : `File ${shoot.mediaCount} ${shoot.mediaCount === 1 ? 'photo' : 'photos'}`}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              ref={inputRef}
              className="input w-full pl-9"
              placeholder="Which property is this?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={`Property for the ${shoot.mediaCount}-photo shoot at ${window_(shoot.startedAt, shoot.endedAt)}`}
            />
            {isFetching && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" />}
          </div>

          {typed.length >= 2 && (
            <>
              {/* Scrolls rather than growing. A project like "Verdant Greens"
                  has thirty units, and letting the list run its full length on
                  a phone pushes the create option — the more common outcome for
                  a floor shot this morning — clean off the screen. */}
              {existing.length > 0 && (
                <ul className="max-h-52 space-y-1 overflow-y-auto">
                  {existing.map((match) => (
                    <li key={match.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-subtle"
                        onClick={() => setChosen({ id: match.id, label: match.label })}
                      >
                        <span className="flex-1 truncate">{match.label}</span>
                        {match.recordNumber && <span className="shrink-0 text-xs text-muted">{match.recordNumber}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {canCreate && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 py-2 text-left text-sm hover:bg-subtle dark:border-slate-700"
                  onClick={() => setChosen({ id: 'new', label: typed })}
                >
                  <Plus className="h-4 w-4 shrink-0 text-muted" />
                  <span className="flex-1 truncate">
                    Add <strong>{typed}</strong> as a new property
                  </span>
                </button>
              )}
              {!existing.length && !canCreate && !isFetching && (
                <p className="px-3 py-2 text-sm text-muted">No match yet — keep typing.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The row of thumbnails.
 *
 * `?size=thumb` serves the generated derivative when the media pipeline has
 * made one and falls back to the original otherwise, so a shoot uploaded
 * minutes ago still shows something rather than four broken frames.
 */
function PreviewStrip({ shoot }: { shoot: UnnamedShoot }): JSX.Element {
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const ids = shoot.previewIds.slice(0, 4);
  const more = shoot.mediaCount - ids.length;

  if (!ids.length) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md bg-subtle text-muted">
        <ImageOff className="h-5 w-5" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-1">
      {ids.map((id, index) => (
        <div key={id} className="relative aspect-square overflow-hidden rounded-md bg-subtle">
          {broken[id] ? (
            <div className="flex h-full items-center justify-center text-muted"><ImageOff className="h-4 w-4" /></div>
          ) : (
            <img
              src={authedFileUrl(`/api/files/${id}`, { size: 'thumb' })}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setBroken((b) => ({ ...b, [id]: true }))}
            />
          )}
          {index === ids.length - 1 && more > 0 && (
            <div className={cn(
              'absolute inset-0 flex items-center justify-center',
              'bg-black/50 text-sm font-medium text-white',
            )}>
              +{more}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
