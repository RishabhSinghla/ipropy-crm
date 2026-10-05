/**
 * The builder's inventory, as the table he already works in.
 *
 * **5 October 2026, the owner**, with a screenshot of a lead's Matching
 * Inventory: *"We want to see a table in Middle Pane under manu bar a Name of
 * Builder's Floor … the Key Fields & Value of this Table View … Mobile Number,
 * Builder Name, House No, Facing, Size, Bedrooms, Status, Amenities, and price
 * for all floor in sam table … Keep in Mind we can use this Builder's Inventory
 * as a matching builder's inventory in Lead Manager as Inventory Matching."*
 *
 * **One table, two places**, because they are the same question with a
 * different filter:
 *
 * * on a **builder floor**, every house in that record's locality — *"we want
 *   create multiple unit of multiple builder under in a locality"*;
 * * on a **contact**, the houses that fit what they are looking for.
 *
 * A second copy would drift, and the way it drifts here is the expensive way:
 * one of them learns about a new floor price and the other keeps showing four
 * columns, so a rep quoting from the lead's tab misses the top floor entirely.
 *
 * **No column is named in this file.** They are the module's own fields, in the
 * order an admin put them in the Field Manager — so adding a sixth floor price,
 * or renaming "Size" to "Plot Size", moves this table with no deploy. That is
 * the whole reason the columns come from `describe` and not from a list here.
 */
import { type JSX, useMemo, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpDown, Building2, Search } from 'lucide-react';
import { api } from '../lib/api';
import type { FieldMeta, FilterGroup, RecordEnvelope } from '@ipropy/shared';
import { FieldValue } from './FieldRenderer';
import { cn } from '../lib/utils';
import { EditableField, isInlineEditable } from './EditableField';
import { CallButton } from './CallDisposition';
import { WhatsAppButton } from './WhatsAppButton';
import { invalidateRecordQueries } from '../lib/invalidate';
import { Spinner } from './ui';

/** The module this table is of. Its name is the API path, as everywhere. */
const MODULE = 'builder_floors';

/**
 * Which blocks the table draws.
 *
 * The house and its floor prices — the two sections his message lists. The
 * others (the building's own facts, the floor plan, photos, the sale) belong on
 * the record, not in a row: a table wide enough to carry forty columns is one
 * nobody reads across.
 */
const TABLE_BLOCKS = ['builder_floor', 'floor_prices'];

/**
 * A column is a field somebody can actually read — not an id, not a flag.
 *
 * Fields carry a `blockId`, not a block *name*, so the two named sections are
 * resolved to their ids first. Filtering on a name that fields do not have
 * answers an empty table, which reads as "there is no inventory".
 */
function columnsFrom(module: { fields: FieldMeta[]; blocks?: { id: string; name: string }[] }): FieldMeta[] {
  const blockNames = new Set(
    (module.blocks ?? []).filter((block) => TABLE_BLOCKS.includes(block.name)).map((block) => block.id),
  );
  return module.fields.filter((field) => (
    field.isActive
    && field.displayType !== 'hidden'
    && field.uitype !== 'autonumber'
    && field.uitype !== 'owner'
    && blockNames.has(field.blockId ?? '')
  ));
}

/**
 * Which columns carry a dropdown filter above the table.
 *
 * A picklist is the only kind of column where "every answer there is" is a
 * short, known list — Status, Facing, Accommodation. Filtering a free-text
 * column belongs to the search box beside them, and filtering a price belongs
 * to the Quick & Live Filters panel, which already does ranges properly.
 *
 * **No column is named here either.** An admin who adds a dropdown to this
 * module gets a filter for it, and one who deletes a dropdown loses the filter
 * with it, neither needing a deploy.
 */
function filterableColumns(columns: FieldMeta[], alreadyFixed: Set<string>): FieldMeta[] {
  return columns.filter((field) => (
    field.uitype === 'picklist'
    && (field.options?.length ?? 0) > 0
    && !alreadyFixed.has(field.name)
  ));
}

/**
 * The fields the table is already pinned to, so no dropdown offers to pin them
 * again. On a locality's own table that is Locality — a control offering to
 * choose a different one, on a table that cannot show one, is a control whose
 * only useful setting is the one it already has.
 */
function fixedFields(filter: FilterGroup, into = new Set<string>()): Set<string> {
  for (const condition of filter.conditions) {
    if ('conditions' in condition) fixedFields(condition as FilterGroup, into);
    else into.add((condition as { field: string }).field);
  }
  return into;
}

export function BuilderFloorTable({ title, filter, emptyLine }: {
  /** What this table is of — the locality, or the contact it is matched to. */
  title: string;
  filter: FilterGroup;
  emptyLine: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { data: module } = useQuery({
    // The same key every other screen reads a module on, so this table warms
    // the record page and the record page warms it.
    queryKey: ['module', MODULE],
    queryFn: () => api.module(MODULE),
    staleTime: 5 * 60_000,
  });

  const columns = useMemo(() => (module ? columnsFrom(module) : []), [module]);
  const dropdowns = useMemo(() => filterableColumns(columns, fixedFields(filter)), [columns, JSON.stringify(filter)]); // eslint-disable-line react-hooks/exhaustive-deps

  const [page, setPage] = useState(1);
  /*
    **5 October 2026, the owner:** *"I want to edit, and filter and search in
    this table."* All three run on the server, against the whole locality rather
    than against the hundred rows on screen — narrowing what is already in front
    of somebody answers the wrong question the moment a locality outgrows a
    page.
  */
  const [search, setSearch] = useState('');
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' } | null>(null);

  const filterKey = JSON.stringify(filter);
  // A new locality starts at page one with nothing chosen: a status filter left
  // over from the last street reads as that street being empty.
  useEffect(() => { setPage(1); setSearch(''); setPicks({}); }, [filterKey]);

  const chosen = Object.entries(picks).filter(([, value]) => value);
  const effectiveFilter = useMemo<FilterGroup>(() => (chosen.length
    ? {
      logic: 'AND',
      conditions: [filter, ...chosen.map(([name, value]) => ({ field: name, operator: 'equals' as const, value }))],
    }
    : filter), [filterKey, JSON.stringify(picks)]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading } = useQuery({
    /*
      The filter is in the key, so the locality table and a contact's matches
      are two cached answers rather than one that keeps replacing the other.
    */
    queryKey: [MODULE, 'table', effectiveFilter, search, sort, page, columns.map((field) => field.name)],
    queryFn: () => api.list(MODULE, {
      filter: effectiveFilter,
      search: search.trim() || undefined,
      ...(sort ? { sortBy: sort.by, sortDir: sort.dir } : {}),
      page,
      pageSize: 100,
      // The columns the table draws, asked for by name: a list row carries only
      // what the list requested, so an unasked column reads back blank — which
      // looks like empty data rather than an unasked question.
      columns: columns.map((field) => field.name),
    }),
    enabled: columns.length > 0,
    staleTime: 30_000,
  });

  const rows: RecordEnvelope[] = data?.rows ?? [];
  const mayEdit = module?.permissions.edit ?? false;
  const narrowed = Boolean(search.trim() || chosen.length);

  if (!module) {
    return <div className="flex justify-center py-10"><Spinner className="text-slate-400" /></div>;
  }

  /** Sort by this column, or turn it round when it is already the one. */
  const sortOn = (name: string): void => {
    setPage(1);
    setSort((current) => (current?.by === name
      ? { by: name, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { by: name, dir: 'asc' }));
  };

  return (
    <section className="card overflow-hidden" data-testid="builder-floor-table">
      <div className="panel-head flex items-center gap-2">
        <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="truncate">{title}</span>
        <span className="shrink-0 font-normal text-muted">({data?.total ?? 0})</span>
      </div>

      {/*
        Search and the dropdowns, above the table they narrow.

        Each dropdown is a plain `<select>` on purpose: this card is
        `overflow-hidden` so a table of thirteen columns cannot drag the page
        sideways, and a popover drawn inside it would be clipped. The browser
        draws a select's list outside the card entirely, so nothing this card
        does to its own overflow can ever cut one off.
      */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="relative min-w-[11rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            aria-label="Search these houses"
            placeholder="Search house, builder, number…"
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            className="input h-8 py-0 pl-8 text-sm"
          />
        </div>
        {dropdowns.map((field) => (
          <select
            key={field.name}
            aria-label={`Filter by ${field.label}`}
            value={picks[field.name] ?? ''}
            onChange={(event) => {
              setPage(1);
              setPicks((current) => ({ ...current, [field.name]: event.target.value }));
            }}
            className="input h-8 w-auto py-0 text-sm"
          >
            <option value="">{`Any ${field.label.toLowerCase()}`}</option>
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ))}
        {narrowed && (
          <button
            type="button"
            className="btn-secondary btn-sm h-8"
            onClick={() => { setSearch(''); setPicks({}); setPage(1); }}
          >
            Clear
          </button>
        )}
      </div>

      {isLoading && rows.length === 0 ? (
        <div className="flex justify-center py-10"><Spinner className="text-slate-400" /></div>
      ) : rows.length === 0 ? (
        /*
          Two different nothings. An empty locality is the module's own line;
          a search that found nobody is the search's fault and says which
          control to undo, because the control that caused it is three inches
          away and easy to forget.
        */
        <p className="px-4 py-10 text-center text-sm text-muted">
          {narrowed ? 'No houses match that search or filter. Press Clear to see the whole locality.' : emptyLine}
        </p>
      ) : (
        /*
          Its own horizontal scroller. Thirteen columns do not fit a middle pane
          at any width worth having, and a table that makes the *page* scroll
          sideways takes the queue and the notes with it.
        */
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="list-head">
              <tr>
                {columns.map((field) => (
                  <th key={field.name} className="whitespace-nowrap px-3 py-2 text-left font-semibold">
                    <button
                      type="button"
                      onClick={() => sortOn(field.name)}
                      title={`Sort by ${field.label}`}
                      className="inline-flex items-center gap-1 hover:text-brand-700 dark:hover:text-brand-300"
                    >
                      {field.label}
                      {sort?.by === field.name
                        ? <span aria-hidden className="text-brand-600">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                        : <ArrowUpDown className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="group border-t border-[var(--border)] hover:bg-[var(--surface-muted)]">
                  {columns.map((field, index) => (
                    /*
                      **The whole cell opens the editor, not just the value.**

                      `EditableField` takes the click on its own box, which is
                      only as wide as the value — so on an empty field that box
                      is a dash in the middle of a wide cell and a click
                      anywhere else hits nothing at all, which reads as editing
                      being broken. The cell forwards to the field's own
                      "Change …" control, so there is still exactly one thing
                      that opens an editor. The same rule as the record form,
                      which met this first.
                    */
                    <td
                      key={field.name}
                      className={cn(
                        'whitespace-nowrap px-3 py-2 align-middle',
                        index > 0 && field.uitype !== 'phone' && mayEdit && isInlineEditable(field)
                          && 'cursor-pointer',
                      )}
                      onClick={(event) => {
                        if (event.target !== event.currentTarget) return;
                        event.currentTarget.querySelector<HTMLButtonElement>('button')?.click();
                      }}
                    >
                      {index === 0 ? (
                        /*
                          The first column opens the house — the one thing in a
                          row that must not turn into an edit box under the
                          cursor, because it is how a rep gets to the record.
                        */
                        <Link
                          to={`/${MODULE}/${row.id}`}
                          className="font-semibold text-brand-700 hover:underline dark:text-brand-300"
                        >
                          {String(row.values?.[field.name] ?? row.label ?? '—')}
                        </Link>
                      ) : field.uitype === 'phone' ? (
                        /*
                          **A number in this table is something to ring.**
                          The call is filed against *this* row's house, not
                          against whichever record the pane happens to have
                          open — a call logged on the wrong house is worse than
                          no log at all.
                        */
                        <span className="flex items-center gap-1">
                          <FieldValue field={field} value={row.values?.[field.name]} display={row.display?.[field.name]} plain />
                          {rowPhone(row, field) && <>
                            <CallButton to={rowPhone(row, field)} plain recordId={row.id} />
                            <WhatsAppButton to={rowPhone(row, field)} iconOnly />
                          </>}
                        </span>
                      ) : mayEdit && isInlineEditable(field) ? (
                        /*
                          Edited where it stands, through the CRM's one editor —
                          so the validation, the permissions, the workflows and
                          the change history are the same here as on the record.
                          A second editor would be a second set of rules to keep
                          in step, and the first time they disagreed nobody
                          would know which had been applied.
                        */
                        <EditableField
                          module={MODULE}
                          recordId={row.id}
                          field={field}
                          value={row.values?.[field.name]}
                          display={row.display?.[field.name]}
                          siblings={row.values}
                          compact
                          plain
                          onSaved={() => invalidateRecordQueries(queryClient, MODULE, row.id)}
                        />
                      ) : (
                        <FieldValue
                          field={field}
                          value={row.values?.[field.name]}
                          display={row.display?.[field.name]}
                          plain
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(data?.totalPages ?? 1) > 1 && <div className="flex items-center justify-end gap-3 border-t px-3 py-2 text-sm">
        <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous houses</button>
        <span>{page} / {data?.totalPages}</span>
        <button type="button" disabled={page >= (data?.totalPages ?? 1)} onClick={() => setPage((value) => value + 1)}>Next houses</button>
      </div>}
    </section>
  );
}

/** The number on a row, as a person would dial it, or '' when there is none. */
function rowPhone(row: RecordEnvelope, field: FieldMeta): string {
  const value = row.display?.[field.name] ?? row.values?.[field.name];
  return value == null ? '' : String(value).trim();
}

/**
 * Every house in one locality — what a builder floor's own middle pane shows.
 *
 * Deliberately **not** narrowed to one builder: the owner's whole sentence is
 * *"multiple unit of multiple builder under in a locality"*, and a rep standing
 * in Greenfields Colony wants everything on offer there, not one seller's share
 * of it.
 */
export function localityFilter(locality: string): FilterGroup {
  return { logic: 'AND', conditions: [locality ? { field: 'locality', operator: 'equals', value: locality } : { field: 'locality', operator: 'is_empty' }] };
}

/**
 * The houses that fit what a contact is looking for.
 *
 * **Every condition is skipped when the contact has not said**, which is the
 * rule that makes this useful rather than empty: most records carry a budget
 * and nothing else, and a matcher that demands all three answers nothing for
 * almost everybody. A contact who has told us nothing sees the whole locality,
 * which is still a better answer than a blank tab.
 *
 * The budget is compared against **every floor price in turn**, ORed — which is
 * the question "is any floor in this house within reach". That is exactly what
 * the owner's table shape makes expressible and what a record-per-floor could
 * not have done more cheaply.
 *
 * `× 1.1` is the same ten per cent of headroom the CRM's own buyer matching
 * uses. A buyer saying "about two crore" does not mean they will refuse a floor
 * at 2.05, and matching on the exact figure hides the house next door.
 */
export function matchesForContact(values: Record<string, unknown>, priceFields: string[]): FilterGroup {
  const conditions: FilterGroup['conditions'] = [];

  const locality = values.locality;
  if (typeof locality === 'string' && locality.trim()) {
    conditions.push({ field: 'locality', operator: 'equals', value: locality });
  }

  const budget = Number(values.budget);
  if (Number.isFinite(budget) && budget > 0 && priceFields.length) {
    conditions.push({
      logic: 'OR',
      conditions: priceFields.map((name) => ({
        field: name, operator: 'less_than' as const, value: Math.round(budget * 1.1),
      })),
    });
  }

  /*
    "3 BHK" is a picklist on the contact and the same picklist here, so the
    values compare directly rather than through a number somebody has to keep
    in step. Bedrooms is the number, and the two say the same thing twice —
    matching on the picklist is the one that cannot drift.
  */
  const wants = values.configuration;
  if (typeof wants === 'string' && wants.trim()) {
    conditions.push({ field: 'accommodation', operator: 'equals', value: wants });
  }

  // Never offer a buyer something already sold or withdrawn.
  conditions.push({ field: 'floor_status', operator: 'not_in', value: ['Sold', 'Not for Sale'] });

  return { logic: 'AND', conditions };
}
