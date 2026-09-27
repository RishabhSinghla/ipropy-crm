import { DEFAULT_PAGE_SIZE } from './pageSize';

/** Open a queue record on the page containing it, preserving its filters and sort. */
export function queueRecordUrl(
  listUrl: string | null | undefined,
  module: string,
  recordId: string,
  position: number | null | undefined,
  dial = false,
  defaultPageSize = DEFAULT_PAGE_SIZE,
): string {
  const target = new URL(listUrl || `/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}`, 'https://crm.local');
  const params = new URLSearchParams(target.search);
  if (position && position > 0) {
    const parsed = Number(params.get('pageSize'));
    const pageSize = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultPageSize;
    const page = Math.floor((position - 1) / pageSize) + 1;
    if (page > 1) params.set('page', String(page));
    else params.delete('page');
  }
  params.set('open', recordId);
  if (dial) params.set('dial', '1');
  else params.delete('dial');
  target.search = params.toString();
  return `${target.pathname}${target.search}`;
}

/** Save & Next opens that queue record and then rings it once. */
export function saveNextUrl(
  listUrl: string | null | undefined,
  module: string,
  recordId: string,
  position: number | null | undefined,
  defaultPageSize = DEFAULT_PAGE_SIZE,
): string {
  return queueRecordUrl(listUrl, module, recordId, position, true, defaultPageSize);
}
