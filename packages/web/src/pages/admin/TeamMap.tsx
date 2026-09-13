import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BatteryLow, MapPin, Navigation, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { relativeTime } from '@ipropy/shared';
import { EmptyState, Skeleton, Toggle } from '../../components/ui';

/**
 * Where everybody's phone last was.
 *
 * **OpenStreetMap, not Google.** Google Maps needs a billing account and a key
 * to draw a single tile; this needs neither, costs nothing, and is the same map
 * data. For a handful of reps in Faridabad the difference is invisible.
 *
 * Two things this screen is careful never to overstate:
 *
 * * **A phone fix is worth ten to twenty metres on a good day.** So every dot
 *   carries the accuracy it was recorded with, and a bad fix is drawn as a
 *   circle rather than a point. It can tell you somebody reached Greenfield
 *   Colony. It cannot tell you which of two adjacent builder floors they walked
 *   into, and a screen that drew a confident pin either way would be lying.
 *
 * * **A phone that has stopped reporting is not a person who has stopped
 *   working.** Android's battery managers kill background apps, basements have
 *   no signal, and handsets run flat. So the last reading is always shown with
 *   how long ago it was and what the battery was doing, because "their phone
 *   died" and "they switched it off" look identical on a map and only one of
 *   those is worth a conversation.
 */

/** Faridabad, so an empty map still opens somewhere meaningful. */
const HOME: [number, number] = [28.4089, 77.3178];

/** Distinct enough to tell six people apart without a legend. */
const COLOURS = ['#4f46e5', '#0ea5e9', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#65a30d'];

function pin(colour: string, initials: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="
        background:${colour};color:#fff;width:32px;height:32px;border-radius:50% 50% 50% 4px;
        transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 6px rgba(0,0,0,.35);border:2px solid #fff;font:600 11px/1 system-ui;
      "><span style="transform:rotate(45deg)">${initials}</span></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 30],
  });
}

const initialsOf = (name: string): string => name
  .split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';

export default function TeamMap(): JSX.Element {
  const map = useRef<L.Map | null>(null);
  const drawn = useRef<L.LayerGroup | null>(null);
  const watcher = useRef<ResizeObserver | null>(null);
  const [ready, setReady] = useState(false);
  const [sized, setSized] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showTrail, setShowTrail] = useState(true);
  const [fitted, setFitted] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['team-locations'],
    queryFn: () => api.teamLocations(),
    // Phones report every few minutes at best, so asking more often than this
    // would be the same answer over and over.
    refetchInterval: 60_000,
  });

  const { data: trail } = useQuery({
    queryKey: ['team-trail', selected],
    queryFn: () => api.teamTrail(selected!, 12),
    enabled: Boolean(selected) && showTrail,
  });

  const positions = useMemo(() => data?.positions ?? [], [data]);
  const settings = data?.settings;

  /**
   * A callback ref, not a `useRef` read from inside an effect.
   *
   * The div only exists once the first answer has arrived — until then this
   * renders a skeleton. An effect with an empty dependency list runs while the
   * skeleton is on screen, finds no div, returns, and never runs again, which
   * is a blank white panel and no error anywhere to explain it. A callback ref
   * fires when the node is actually attached, whenever that turns out to be.
   *
   * It fires with `null` when the div goes away too, which is the right moment
   * to give Leaflet's own listeners and tile requests back.
   */
  const holder = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      watcher.current?.disconnect();
      watcher.current = null;
      map.current?.remove();
      map.current = null;
      drawn.current = null;
      setReady(false);
      setSized(false);
      // The next map is a new map, so it should frame itself again.
      setFitted(false);
      return;
    }
    if (map.current) return;

    const instance = L.map(node, { zoomControl: true }).setView(HOME, 12);
    // Do not use the public OpenStreetMap volunteer tile servers for the CRM.
    // A team map loads many tiles at once and those servers correctly return
    // 403 when that usage breaches their tile policy, leaving the screen full
    // of error images. CARTO's public light basemap is designed for this kind
    // of application use and keeps the map readable behind coloured pins.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      detectRetina: true,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    }).addTo(instance);
    map.current = instance;
    drawn.current = L.layerGroup().addTo(instance);
    setReady(true);

    /**
     * Leaflet measures its box once, when the map is made, and believes that
     * measurement until told otherwise. This panel is a flex child that has no
     * height yet at that moment, so the first measurement is zero — and a
     * zero-sized map cannot work out a zoom that fits three pins, so it falls
     * back on the cap it was given and lands miles away on empty fields. There
     * is no error; the map simply shows the wrong place.
     *
     * So: watch the box, tell Leaflet whenever it changes, and hold the framing
     * back until there is a real box to frame against.
     */
    const observer = new ResizeObserver(() => {
      instance.invalidateSize();
      // Same value repeatedly is a no-op in React, so this cannot loop.
      if (node.clientHeight > 50 && node.clientWidth > 50) setSized(true);
    });
    observer.observe(node);
    watcher.current = observer;
  }, []);

  useEffect(() => {
    const instance = map.current;
    const layer = drawn.current;
    if (!instance || !layer) return;
    layer.clearLayers();

    positions.forEach((person, index) => {
      const colour = COLOURS[index % COLOURS.length]!;
      const here: [number, number] = [person.latitude, person.longitude];

      // A fix worse than about a street width is drawn as the area it could be
      // in, not as a point. Anything tighter than that is noise on this scale.
      if (person.accuracyM && person.accuracyM > 40) {
        L.circle(here, {
          radius: person.accuracyM, color: colour, weight: 1,
          fillColor: colour, fillOpacity: 0.08,
        }).addTo(layer);
      }

      const at = person.atProperty
        ? `<br><b>At ${person.atProperty.label}</b>${
          person.atPropertyMinutes ? ` for ${person.atPropertyMinutes} min` : ''
        }<br><span style="opacity:.7">${person.atProperty.metres} m from the pin</span>`
        : '';

      L.marker(here, { icon: pin(colour, initialsOf(person.name)) })
        .addTo(layer)
        .bindPopup(
          `<b>${person.name}</b><br>${relativeTime(person.recordedAt)}`
          + (person.accuracyM ? `<br><span style="opacity:.7">accurate to about ${Math.round(person.accuracyM)} m</span>` : '')
          + at,
        )
        .on('click', () => setSelected(person.userId));
    });

    if (selected && showTrail && trail?.trail?.length) {
      const index = positions.findIndex((p) => p.userId === selected);
      const colour = COLOURS[(index < 0 ? 0 : index) % COLOURS.length]!;
      L.polyline(trail.trail.map((p) => [p.latitude, p.longitude] as [number, number]), {
        color: colour, weight: 3, opacity: 0.65, dashArray: '6 6',
      }).addTo(layer);
    }

    // Fit once. Re-fitting on every refresh would yank the map out from under
    // somebody who had just panned to look at something.
    if (!fitted && sized && positions.length) {
      instance.fitBounds(
        L.latLngBounds(positions.map((p) => [p.latitude, p.longitude] as [number, number])),
        { padding: [60, 60], maxZoom: 15 },
      );
      setFitted(true);
    }
  }, [ready, sized, positions, trail, selected, showTrail, fitted]);

  return (
    // Scrolls on a phone, fills the height on a desktop. The two panels below
    // want opposite things: on a narrow screen they stack and the page should
    // grow, and in one column a flex parent that owns the height instead
    // squeezes both rows until the map — which has a floor — spills over the
    // list underneath it.
    <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-6 lg:overflow-hidden">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Team map</h1>
          <p className="text-sm text-muted">
            {settings?.enabled
              ? `Each phone reports every ${settings.everyMinutes} minutes${
                settings.fromHour === settings.toHour
                  ? ', around the clock'
                  : `, between ${settings.fromHour}:00 and ${settings.toHour}:00`
              }. History is kept for ${settings.keepDays} days.`
              : 'Recording is switched off. Turn it on under Settings → Where the team is.'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">
            <Toggle checked={showTrail} onChange={setShowTrail} /> Show today's path
          </label>
          <button onClick={() => void refetch()} className="btn-secondary btn-sm" disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-[28rem] w-full" />
      ) : !positions.length ? (
        <EmptyState
          icon={<MapPin className="h-8 w-8" />}
          title={settings?.enabled ? 'No phone has reported yet' : 'Location recording is off'}
          body={settings?.enabled
            ? 'The companion app sends a position every few minutes once a rep has granted location access and allowed it in the background. Nothing appears here until one does.'
            : 'Switch it on under Settings → Where the team is. Tell your team first — it is their personal data.'}
        />
      ) : (
        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="card h-fit overflow-hidden lg:max-h-[34rem] lg:overflow-y-auto">
            <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
              <p className="text-xs font-medium text-muted">{positions.length} reporting</p>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {positions.map((person, index) => {
                const stale = Date.now() - new Date(person.recordedAt).getTime() > 90 * 60_000;
                return (
                  <button
                    key={person.userId}
                    onClick={() => {
                      setSelected(person.userId);
                      map.current?.setView([person.latitude, person.longitude], 16);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2.5 p-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40',
                      selected === person.userId && 'bg-brand-50 dark:bg-brand-950/40',
                    )}
                  >
                    <span
                      className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: COLOURS[index % COLOURS.length] }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{person.name}</span>
                      <span className={cn('block text-2xs', stale ? 'text-negative' : 'text-muted')}>
                        {relativeTime(person.recordedAt)}
                        {stale && ' · not reporting'}
                      </span>
                      {person.atProperty && (
                        <span className="mt-0.5 flex items-center gap-1 text-2xs text-positive">
                          <Navigation className="h-3 w-3" />
                          At {person.atProperty.label}
                          {person.atPropertyMinutes ? ` · ${person.atPropertyMinutes} min` : ''}
                        </span>
                      )}
                      {typeof person.batteryPct === 'number' && person.batteryPct <= 20 && (
                        <span className="mt-0.5 flex items-center gap-1 text-2xs text-amber-600 dark:text-amber-400">
                          <BatteryLow className="h-3 w-3" /> Battery {person.batteryPct}%
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="card h-[24rem] overflow-hidden lg:h-auto lg:min-h-0">
            <div ref={holder} className="h-full w-full" />
          </div>
        </div>
      )}

      <p className="mt-3 text-2xs text-muted">
        A phone fix is accurate to ten or twenty metres at best, so this tells you somebody reached an
        address, not which floor of it they are standing on. A rep who stops appearing has most likely
        run out of battery or signal, or had the app closed by their phone.
      </p>
    </div>
  );
}
