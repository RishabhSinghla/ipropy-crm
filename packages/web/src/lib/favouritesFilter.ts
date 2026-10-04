/** Recognise the favourites scope even with other filters and URL parameters. */
export function hasFavouriteFilter(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const node = value as { field?: string; operator?: string; conditions?: unknown[] };
  return node.field === 'favourite' && node.operator === 'is_true'
    || Array.isArray(node.conditions) && node.conditions.some(hasFavouriteFilter);
}
