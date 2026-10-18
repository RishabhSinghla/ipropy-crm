import type { ListQuery } from '@ipropy/shared';

/** A durable snapshot of the rows and order the caller actually saw. */
/** `base` is `/archive` when the queue is the Archive's, so a move stays inside it. */
export function callQueueUrl(module: string, query: ListQuery, base = ''): string {
  const params = new URLSearchParams();
  if (query.view) params.set('view', query.view);
  if (query.aiCalls) params.set('aiCalls', query.aiCalls);
  if (query.search) params.set('q', query.search);
  if (query.filter) params.set('filter', JSON.stringify(query.filter));
  if (query.sortBy) params.set('sort', query.sortBy);
  if (query.sortBy && query.sortDir) params.set('dir', query.sortDir);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  return `${base}/${encodeURIComponent(module)}?${params.toString()}`;
}
