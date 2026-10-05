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
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { api } from '../lib/api';
import type { FieldMeta, FilterGroup, RecordEnvelope } from '@ipropy/shared';
import { FieldValue } from './FieldRenderer';
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

export function BuilderFloorTable({ title, filter, emptyLine }: {
  /** What this table is of — the locality, or the contact it is matched to. */
  title: string;
  filter: FilterGroup;
  emptyLine: string;
}): JSX.Element {
  const { data: module } = useQuery({
    // The same key every other screen reads a module on, so this table warms
    // the record page and the record page warms it.
    queryKey: ['module', MODULE],
    queryFn: () => api.module(MODULE),
    staleTime: 5 * 60_000,
  });

  const columns = useMemo(() => (module ? columnsFrom(module) : []), [module]);
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify(filter);
  useEffect(() => { setPage(1); }, [filterKey]);

  const { data, isLoading } = useQuery({
    /*
      The filter is in the key, so the locality table and a contact's matches
      are two cached answers rather than one that keeps replacing the other.
    */
    queryKey: [MODULE, 'table', filter, page, columns.map((field) => field.name)],
    queryFn: () => api.list(MODULE, {
      filter,
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

  if (isLoading || !module) {
    return <div className="flex justify-center py-10"><Spinner className="text-slate-400" /></div>;
  }

  return (
    <section className="card overflow-hidden" data-testid="builder-floor-table">
      <div className="panel-head flex items-center gap-2">
        <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="truncate">{title}</span>
        <span className="shrink-0 font-normal text-muted">({data?.total ?? 0})</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted">{emptyLine}</p>
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
                    {field.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-[var(--border)] hover:bg-[var(--surface-muted)]">
                  {columns.map((field, index) => (
                    <td key={field.name} className="whitespace-nowrap px-3 py-2 align-middle">
                      {/*
                        The first column opens the house. Everything else is the
                        value as the CRM draws it everywhere — a price in lakhs
                        and crores, a status as its own coloured chip, amenities
                        as chips — because `FieldValue` is what every other
                        screen uses and a table that formatted its own numbers
                        would disagree with the record beside it.

                        `plain` so a phone renders as text rather than as a dial
                        link with a WhatsApp button beside it: inside a row that
                        is already a link, a link inside a link is the trap the
                        record form met in September.
                      */}
                      {index === 0 ? (
                        <Link
                          to={`/${MODULE}/${row.id}`}
                          className="font-semibold text-brand-700 hover:underline dark:text-brand-300"
                        >
                          {String(row.values?.[field.name] ?? row.label ?? '—')}
                        </Link>
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
