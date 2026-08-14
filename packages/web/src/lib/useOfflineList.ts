/**
 * Keep the last list a person saw, and hand it back when the signal goes.
 *
 * The rule this respects, from `offlineCache.ts`: a remembered list is never
 * passed off as current. It is returned only when the request has actually
 * failed and the browser says there is no connection, and it arrives with the
 * time it was fetched so the screen can say so.
 *
 * Only the first page of an unfiltered list is remembered. A rep in a basement
 * wants to find a person, not to page through a filtered view — and writing a
 * snapshot for every combination of filter, sort and page would fill the
 * device with copies nobody will ever read back.
 */
import { useEffect, useState } from 'react';
import type { ListQuery, ListResult, RecordEnvelope } from '@ipropy/shared';
import { asOf, recall, remember } from './offlineCache';

export interface OfflineList {
  rows: RecordEnvelope[];
  /** True when these rows came out of the cache rather than off the network. */
  stale: boolean;
  /** When they were fetched, phrased for a person. */
  asOf: string | null;
}

/** Worth remembering? Only the plain first page — see the note above. */
function isRememberable(query: ListQuery): boolean {
  return (query.page ?? 1) === 1 && !query.search && !query.filter;
}

export function useOfflineList(
  moduleName: string | undefined,
  query: ListQuery,
  data: ListResult | undefined,
  userId: string | undefined,
  failed: boolean,
): OfflineList {
  const [fallback, setFallback] = useState<{ rows: RecordEnvelope[]; fetchedAt: string } | null>(null);

  // Remember a good answer.
  useEffect(() => {
    if (!userId || !moduleName || !data?.rows || !isRememberable(query)) return;
    void remember(userId, `list:${moduleName}`, data.rows.slice(0, 100));
  }, [userId, moduleName, data, query]);

  // Reach for the copy only once the live request has actually failed.
  //
  // Not `navigator.onLine`: it reports whether the device has a network
  // interface, not whether anything is reachable through it, and the case this
  // exists for — one bar in the basement of a half-built floor — reports
  // online while every request times out. A failed request is the honest
  // signal, and it also covers the server being down or a captive portal,
  // which look identical from here and matter just as much.
  //
  // Only for the plain first page. Serving a remembered *unfiltered* list to
  // somebody who searched for "Riya" would answer a question they did not ask,
  // which is worse than saying the search needs a connection.
  useEffect(() => {
    let cancelled = false;
    if (data || !failed || !userId || !moduleName || !isRememberable(query)) {
      setFallback(null);
      return () => { cancelled = true; };
    }
    void recall<RecordEnvelope[]>(userId, `list:${moduleName}`).then((snapshot) => {
      if (!cancelled && snapshot) setFallback({ rows: snapshot.data, fetchedAt: snapshot.fetchedAt });
    });
    return () => { cancelled = true; };
  }, [data, failed, userId, moduleName, query]);

  if (data?.rows) return { rows: data.rows, stale: false, asOf: null };
  if (fallback) return { rows: fallback.rows, stale: true, asOf: asOf(fallback.fetchedAt) };
  return { rows: [], stale: false, asOf: null };
}

/**
 * The module's shape, remembered.
 *
 * A list cannot render without knowing its own columns, so an unreachable
 * server leaves the screen blank however many records are cached. Metadata is
 * also the safest thing here to keep: field labels and types change when an
 * administrator edits them, not minute to minute, and an hour-old column list
 * showing a real record is a far better answer than nothing at all.
 */
export function useOfflineMeta<T>(
  moduleName: string | undefined,
  live: T | undefined,
  userId: string | undefined,
): T | undefined {
  const [fallback, setFallback] = useState<T | undefined>();

  useEffect(() => {
    if (!userId || !moduleName || !live) return;
    void remember(userId, `meta:${moduleName}`, live);
  }, [userId, moduleName, live]);

  useEffect(() => {
    let cancelled = false;
    if (live || !userId || !moduleName) { setFallback(undefined); return () => { cancelled = true; }; }
    void recall<T>(userId, `meta:${moduleName}`).then((snapshot) => {
      if (!cancelled && snapshot) setFallback(snapshot.data);
    });
    return () => { cancelled = true; };
  }, [live, userId, moduleName]);

  return live ?? fallback;
}
