/** Every match for the top search box, grouped by module — what "See all" opens. */
import { type JSX, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { relativeTime } from '@ipropy/shared';
import { api } from '../lib/api';
import { groupHits } from '../lib/searchGroups';
import { Avatar, Badge, EmptyState, Spinner } from '../components/ui';
import { RestrictedHit } from '../components/Layout';

export default function SearchResults(): JSX.Element {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const { data, isLoading, error } = useQuery({ queryKey: ['search-all', q], queryFn: () => api.search(q, 200), enabled: q.length >= 2 });
  const groups = useMemo(() => groupHits(data ?? []), [data]);
  return <div className="mx-auto max-w-4xl space-y-4 p-4">
    <h1 className="text-lg font-semibold">Search results for “{q}”</h1>
    {q.length < 2 && <EmptyState title="Type at least two letters to search" />}
    {isLoading && <div className="flex justify-center py-10"><Spinner /></div>}
    {error && <p className="text-sm text-negative">Search failed: {(error as Error).message}</p>}
    {data && !groups.length && <EmptyState title={`No matches for “${q}”`} />}
    {groups.map((group) => <section key={group.module} data-search-module={group.module} className="card overflow-hidden">
      <h2 className="flex items-center gap-2 bg-[var(--surface-muted)] px-3 py-2 text-xs font-bold uppercase tracking-wider text-muted">{group.label}<Badge>{group.hits.length}</Badge></h2>
      {group.hits.map((hit) => hit.restricted ? <RestrictedHit key={hit.id} hit={hit} /> :
        <Link key={hit.id} to={`${hit.archived ? '/archive' : ''}/${hit.module}?open=${hit.id}`} className="flex items-center gap-3 border-t border-[var(--border)] px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800">
          <Avatar name={hit.label} size={32} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-semibold"><span className="truncate">{hit.label}</span>{hit.archived && <Badge>Archived</Badge>}{hit.mobile && <span className="shrink-0 text-xs font-medium text-slate-600 dark:text-slate-300">{hit.mobile}</span>}</span>
            <span className="block truncate text-xs text-muted">{hit.details || [hit.recordNumber, hit.ownerName, hit.updatedAt && relativeTime(hit.updatedAt)].filter(Boolean).join(' · ')}</span>
          </span>
        </Link>)}
    </section>)}
  </div>;
}
