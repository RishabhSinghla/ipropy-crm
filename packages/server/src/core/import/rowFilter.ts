/**
 * Importing part of a file.
 *
 * A portal export holds everything the portal has — closed enquiries, other
 * cities, the commercial stock a residential desk does not want. The answer
 * people reach for otherwise is to delete rows in Excel first, which loses the
 * file they were sent and takes an hour.
 *
 * Conditions read the *file's own columns*, not the CRM's fields, because they
 * are decided while looking at the spreadsheet and a column can be filtered on
 * without being imported at all.
 */
export type FilterOp = 'is' | 'is_not' | 'contains' | 'does_not_contain' | 'is_empty' | 'is_not_empty';

export interface RowFilter {
  header: string;
  op: FilterOp;
  value?: string;
}

const fold = (v: unknown): string => String(v ?? '').trim().toLowerCase();

function passes(cell: string, filter: RowFilter): boolean {
  const want = fold(filter.value);
  switch (filter.op) {
    case 'is': return cell === want;
    case 'is_not': return cell !== want;
    case 'contains': return cell.includes(want);
    case 'does_not_contain': return !cell.includes(want);
    case 'is_empty': return cell === '';
    case 'is_not_empty': return cell !== '';
    default: return true;
  }
}

/**
 * Every condition must hold. One that names a column the file has not got is
 * ignored rather than silently rejecting the whole file — a saved template
 * outliving a change to the export is the ordinary way that happens.
 */
export function keepRow(
  row: Record<string, string>, filters: RowFilter[], headers: string[],
): { keep: true } | { keep: false; because: string } {
  for (const filter of filters) {
    if (!headers.includes(filter.header)) continue;
    if (passes(fold(row[filter.header]), filter)) continue;
    const said = filter.op === 'is_empty' ? 'is not empty'
      : filter.op === 'is_not_empty' ? 'is empty'
        : `is “${String(row[filter.header] ?? '').trim()}”`;
    return { keep: false, because: `${filter.header} ${said}` };
  }
  return { keep: true };
}

export function parseFilters(raw: unknown): RowFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    const o = f as Record<string, unknown>;
    const header = typeof o.header === 'string' ? o.header : '';
    const op = String(o.op) as FilterOp;
    const known: FilterOp[] = ['is', 'is_not', 'contains', 'does_not_contain', 'is_empty', 'is_not_empty'];
    if (!header || !known.includes(op)) return [];
    return [{ header, op, value: typeof o.value === 'string' ? o.value : '' }];
  });
}
