/** Build the list destination for Save & Next without losing its queue context. */
export function saveNextUrl(
  listUrl: string | null | undefined,
  module: string,
  recordId: string,
  position: number | null | undefined,
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
  params.set('dial', '1');
  target.search = params.toString();
  return `${target.pathname}${target.search}`;
}
import { DEFAULT_PAGE_SIZE } from './pageSize';
