/**
 * Matching: the two-way bridge between Contacts and Inventory.
 *
 * On a contact it lists the units that fit the stated requirement; on a unit it
 * runs the same engine in reverse and lists the contacts worth pitching. Both
 * directions share one table.
 *
 * What this screen shows about each match is **not** fetched from the matching
 * endpoint. That endpoint answers "which records, and how well" — ids, a score
 * and which configured fields matched — and the rest of a row is ordinary
 * record data. So the ids come back from the engine and the row content comes
 * from the records API, one call, filtered to those ids.
 *
 * That is worth being deliberate about, because the alternative was to widen
 * the match payload with a mobile number, a status and an assignee. Doing it
 * this way means the columns here obey field permissions, masking, dependent
 * picklists and display formatting for free — every one of which would have
 * had to be re-implemented on the match payload, and the masked-number rule
 * in particular is the sort of thing that gets re-implemented wrongly once and
 * leaks a number to somebody who should not have it.
 *
 * Columns are resolved from metadata rather than named against the database.
 * A field this business renamed last month still lands in the right column,
 * and one it deleted drops its column instead of raising 42703 — which is the
 * single most repeated outage in this codebase's history.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  type BuyerMatch, type FieldMeta, type ModuleMeta, type PropertyMatch, type RecordEnvelope,
} from '@ipropy/shared';
import {
  ChevronDown, ChevronLeft, ChevronRight, Eye, Link2, Lock, RefreshCw, RotateCcw, Save, Search, Share2,
} from 'lucide-react';
import { api } from '../lib/api';
import { assignmentField, byLabel, fieldByKey } from '../lib/fields';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { FieldValue } from './FieldRenderer';
import {
  Dropdown, EmptyState, Modal, ScoreChip, Skeleton, Spinner,
} from './ui';

/**
 * One column, and how to find the field behind it.
 *
 * `find` runs against the target module's own fields, so a column exists only
 * when this business actually has that field. Nothing here names a database
 * column; `fieldByKey` tolerates a rename by falling back to the column name,
 * and a field that is genuinely gone simply yields no column.
 */
interface ColumnSpec {
  key: string;
  /** Shown when the field cannot name itself — only for the two system columns. */
  fallbackLabel?: string;
  find?: (fields: FieldMeta[], meta: ModuleMeta) => FieldMeta | undefined;
  /** For the columns that are not fields at all: the record's identity and its clock. */
  system?: 'label' | 'updatedAt';
  className?: string;
}

const PHONE = (fields: FieldMeta[]): FieldMeta | undefined => fields.find((f) => f.uitype === 'phone');

/** Contacts matched to a unit. */
const LEAD_COLUMNS: ColumnSpec[] = [
  { key: 'label', system: 'label', fallbackLabel: 'Lead', className: 'min-w-44' },
  { key: 'contact_type', find: (f) => fieldByKey(f, 'contact_type') },
  { key: 'mobile', find: PHONE },
  { key: 'status', find: (f, m) => (m.pipelineField ? fieldByKey(f, m.pipelineField) : undefined) },
  { key: 'assigned', find: (f) => assignmentField(f) },
  { key: 'updated', system: 'updatedAt', fallbackLabel: 'Updated' },
];

/** Units matched to a contact. */
const INVENTORY_COLUMNS: ColumnSpec[] = [
  { key: 'label', system: 'label', fallbackLabel: 'Full Name', className: 'min-w-44' },
  { key: 'unit', find: (f) => fieldByKey(f, 'unit_no') ?? fieldByKey(f, 'unit_number') },
  { key: 'contact_type', find: (f) => fieldByKey(f, 'contact_type') },
  { key: 'mobile', find: PHONE },
  { key: 'assigned', find: (f) => assignmentField(f) },
  { key: 'updated', system: 'updatedAt', fallbackLabel: 'Last updated' },
];

export function MatchingTab({
  module, id, returnQuery,
}: { module: string; id: string; returnQuery: string }): JSX.Element {
  const isContact = module === 'leads';
  const targetModule = isContact ? 'properties' : 'leads';
  const queryClient = useQueryClient();

  const [mappedFilters, setMappedFilters] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [peekAt, setPeekAt] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);

  const { data: matchingFields } = useQuery({
    queryKey: ['matching-fields'], queryFn: () => api.matchingFields(), staleTime: 60_000,
  });
  const mappedFields = useMemo(() => byLabel(
    (matchingFields ?? [])
      .map((pair) => ({ key: pair.contactField, label: isContact ? pair.propertyLabel : pair.contactLabel }))
      .filter((f) => f.key && f.label),
  ), [matchingFields, isContact]);

  /*
    A saved matching, if somebody froze one.

    The engine re-scores on every change, which is right for a live list and
    wrong the moment a rep has been through it, taken some out and sent the
    rest to a customer — the next repricing silently rewrites what was agreed.
    Saving pins the list; Revert throws the pin away and shows the engine's
    answer again.
  */
  const { data: saved, refetch: refetchSaved } = useQuery({
    queryKey: ['match-snapshot', module, id],
    queryFn: () => api.matchSnapshot(module, id),
    staleTime: 30_000,
  });

  const { data: live, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['matching', module, id],
    queryFn: (): Promise<{ matches?: PropertyMatch[]; buyers?: BuyerMatch[] }> => (
      isContact ? api.matchProperties(module, id, false, 50) : api.buyersForProperty(id, false, 50)
    ),
    staleTime: 60_000,
  });

  /** Score and matched fields per target id, from whichever source is in force. */
  const ranked = useMemo(() => {
    if (saved) {
      return saved.entries.map((e) => ({ id: e.targetId, score: e.score, matchedFields: e.matchedFields ?? [] }));
    }
    if (isContact) {
      return ((live as { matches?: PropertyMatch[] } | undefined)?.matches ?? [])
        .map((m) => ({ id: m.propertyId, score: m.score, matchedFields: m.matchedFields ?? [] }));
    }
    return ((live as { buyers?: BuyerMatch[] } | undefined)?.buyers ?? [])
      .map((b) => ({ id: b.recordId, score: b.score, matchedFields: b.matchedFields ?? [] }));
  }, [saved, live, isContact]);

  const visible = useMemo(
    () => ranked.filter((r) => mappedFilters.every((key) => r.matchedFields.includes(key))),
    [ranked, mappedFilters],
  );
  const ids = useMemo(() => visible.map((r) => r.id), [visible]);

  const { data: targetMeta } = useQuery({
    queryKey: ['module', targetModule],
    queryFn: () => api.module(targetModule),
    staleTime: 5 * 60_000,
  });

  /*
    The rows, from the records API rather than the match payload.

    Filtered to exactly the ids the engine returned, so this is one query
    whatever the list length, and every value in it has already been through
    field permissions and display formatting on the way out.
  */
  const { data: rowsPage, isLoading: loadingRows } = useQuery({
    queryKey: ['matching-rows', targetModule, ids],
    queryFn: () => api.list(targetModule, {
      page: 1,
      pageSize: Math.max(ids.length, 1),
      filter: { logic: 'AND', conditions: [{ field: 'id', operator: 'in', value: ids }] },
    }),
    enabled: ids.length > 0,
    staleTime: 30_000,
  });

  /** Rows back in the engine's order — the records API answers in its own. */
  const rows = useMemo(() => {
    const byId = new Map((rowsPage?.rows ?? []).map((r) => [r.id, r]));
    return visible
      .map((r) => ({ ...r, row: byId.get(r.id) }))
      .filter((r): r is typeof r & { row: RecordEnvelope } => Boolean(r.row));
  }, [rowsPage, visible]);

  const columns = useMemo(() => {
    if (!targetMeta) return [];
    const specs = isContact ? INVENTORY_COLUMNS : LEAD_COLUMNS;
    return specs
      .map((spec) => ({ spec, field: spec.find?.(targetMeta.fields, targetMeta) }))
      // A column whose field this business deleted drops out rather than
      // rendering an empty strip with a header nobody can explain.
      .filter((c) => Boolean(c.field) || Boolean(c.spec.system))
      .filter((c) => !c.field || (c.field.isActive && c.field.displayType !== 'hidden'));
  }, [targetMeta, isContact]);

  // Selecting rows, then filtering them away, would otherwise share a link to
  // records no longer on screen.
  useEffect(() => {
    setSelected((prev) => {
      const onScreen = new Set(ids);
      const next = new Set([...prev].filter((x) => onScreen.has(x)));
      // Same set, same object: returning a fresh Set every time `ids` changes
      // would re-render every row for nothing.
      return next.size === prev.size ? prev : next;
    });
  }, [ids]);

  /*
    What gets pinned: the rows somebody ticked, or all of them if they ticked
    none.

    Filtering and saving was the only curation available, and "these six, not
    those three" is not something a filter can say — the engine's shortlist is
    a starting point and the rep's judgement is the rest of it. The Actions
    column that used to carry shortlist/not-suitable is gone on purpose; the
    checkboxes that replaced it already express the same thing, and now they
    decide what Save keeps.

    Ticking nothing still means "pin what I am looking at", because that is
    what the button plainly reads as when no row is ticked.
  */
  const toPin = selected.size ? visible.filter((v) => selected.has(v.id)) : visible;

  const saveMutation = useMutation({
    mutationFn: () => api.saveMatchSnapshot(module, id, {
      entries: toPin.map((v) => ({ targetId: v.id, score: v.score, matchedFields: v.matchedFields })),
      filters: mappedFilters,
    }),
    onSuccess: () => {
      toast.success(
        `Matching saved — ${toPin.length} ${toPin.length === 1 ? 'record' : 'records'}`,
        'It stays exactly as it is until somebody reverts it.',
      );
      setSelected(new Set());
      void refetchSaved();
    },
    onError: (e: Error) => toast.error('Could not save this matching', e.message),
  });

  const revertMutation = useMutation({
    mutationFn: () => api.clearMatchSnapshot(module, id),
    onSuccess: () => {
      toast.success('Back to the system’s matching');
      setMappedFilters([]);
      void refetchSaved();
      void queryClient.invalidateQueries({ queryKey: ['matching', module, id] });
    },
    onError: (e: Error) => toast.error('Could not revert', e.message),
  });

  const heading = isContact ? 'Matching inventory' : 'Matching leads';

  /*
    No `overflow-hidden` on the card.

    The Match filters menu is positioned, not portalled, so an ancestor that
    clips its overflow clips the menu — and this only shows itself when the
    table is *short*: with fifty rows the card is taller than the menu and
    nothing looks wrong, with one row the menu is sliced off halfway down its
    list. The rounding that `overflow-hidden` was there for moves to the table
    wrapper below, which is the thing that actually needs clipping.
  */
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <Link2 className="h-4 w-4 shrink-0 text-brand-500" />
        <span className="text-sm font-medium">
          {heading}{' '}
          {/*
            Count the rows on screen, not the ids that were ranked.

            A saved matching holds ids, and a unit deleted since it was saved is
            an id that no longer resolves to a row. Counting `visible` would
            have the heading say 48 above a table with 47 in it — quietly, and
            only on the records where somebody had pinned a list weeks ago,
            which is the hardest place to notice it.
          */}
          <span className="tnum text-brand-600">
            ({rows.length === ranked.length ? ranked.length : `${rows.length} of ${ranked.length}`})
          </span>
        </span>

        {saved && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-2xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            <Lock className="h-3 w-3" />
            Saved by {saved.savedByName} · {new Date(saved.savedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/*
            The configured match fields, in a menu rather than strewn across
            the toolbar.

            They used to be a row of bordered checkboxes that appeared under
            the header and pushed the table down — seven of them on a
            business with seven mapped fields, wrapping onto two lines. A
            count on the button says how many are on without spending a line
            of the screen on the ones that are off.
          */}
          {mappedFields.length > 0 && (
            <Dropdown
              align="right"
              className="w-64"
              trigger={(
                <button className={cn('btn-secondary btn-sm', mappedFilters.length && 'border-brand-400 text-brand-700 dark:text-brand-300')}>
                  <Link2 className="h-3.5 w-3.5" />
                  Match filters
                  {mappedFilters.length ? <span className="rounded-full bg-brand-600 px-1.5 text-2xs text-white">{mappedFilters.length}</span> : null}
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              )}
            >
              {() => (
                <>
                  <p className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted">
                    Matching Setup fields
                  </p>
                  <div className="max-h-64 overflow-y-auto py-1">
                    {mappedFields.map((f) => (
                      <label key={f.key} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-slate-300"
                          checked={mappedFilters.includes(f.key)}
                          onChange={(e) => setMappedFilters((cur) => (
                            e.target.checked ? [...cur, f.key] : cur.filter((k) => k !== f.key)
                          ))}
                        />
                        <span className="truncate">{f.label}</span>
                      </label>
                    ))}
                  </div>
                  {mappedFilters.length > 0 && (
                    <div className="border-t border-slate-100 p-1 dark:border-slate-800">
                      <button className="w-full rounded px-3 py-1.5 text-left text-xs text-brand-700 hover:bg-slate-50 dark:text-brand-300 dark:hover:bg-slate-800" onClick={() => setMappedFilters([])}>
                        Clear all filters
                      </button>
                    </div>
                  )}
                </>
              )}
            </Dropdown>
          )}

          <button
            className="btn-secondary btn-sm"
            disabled={!selected.size}
            onClick={() => setSharing(true)}
            title={selected.size ? `Share ${selected.size} selected` : 'Tick some rows to share them'}
          >
            <Share2 className="h-3.5 w-3.5" />
            Share{selected.size ? ` (${selected.size})` : ''}
          </button>

          {saved ? (
            <button className="btn-secondary btn-sm" onClick={() => revertMutation.mutate()} disabled={revertMutation.isPending}>
              <RotateCcw className="h-3.5 w-3.5" /> Revert
            </button>
          ) : (
            <button
              className="btn-secondary btn-sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !toPin.length}
              title={selected.size
                ? `Pin just the ${selected.size} you have ticked`
                : 'Pin this list exactly as it stands'}
            >
              <Save className="h-3.5 w-3.5" />
              {selected.size ? `Save ${selected.size}` : 'Save'}
            </button>
          )}

          <Link to={isContact ? '/properties' : '/leads'} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">
            <Search className="h-3 w-3" />
            {isContact ? 'Browse all inventory' : 'Browse all leads'}
          </Link>

          <button onClick={() => void refetch()} disabled={isFetching || Boolean(saved)} aria-label="Refresh matches" className="btn-ghost btn-sm" title={saved ? 'This matching is saved — revert to re-run it' : 'Refresh'}>
            {isFetching ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {isLoading || (ids.length > 0 && loadingRows && !rowsPage) ? (
        <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : !rows.length ? (
        <EmptyState
          icon={<Link2 className="h-8 w-8" />}
          title={isContact ? 'No matching inventory' : 'No matching leads'}
          body={ranked.length && !visible.length
            ? 'Every match was filtered out. Clear a match filter to see them again.'
            : ranked.length && !rows.length
              // Ids that no longer resolve: a saved matching whose records have
              // been deleted since. Saying so is better than "nothing fits",
              // which sends somebody looking for a pricing problem.
              ? 'The records in this saved matching have all been deleted. Revert to run it again.'
              : isContact
                ? 'Nothing available fits the stated requirement right now. Add or reprice a unit, or widen the requirement.'
                : 'No open lead fits this unit yet. It sells itself when one arrives — check back after the next enquiry.'}
        />
      ) : (
        // Capped height with its own scroll: fifty matches is a real scroll,
        // and a table whose column names have left the screen is a grid of
        // numbers. `.list-head` is already sticky, so it stays put in here.
        <div className="max-h-[65vh] overflow-auto rounded-b-xl">
          <table className="w-full">
            <thead>
              <tr>
                <th className="list-head w-10 px-0 text-center">
                  <input
                    type="checkbox"
                    aria-label="Select every match"
                    className="h-3.5 w-3.5 rounded border-slate-300"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th className="list-head w-20">Fit</th>
                {columns.map(({ spec, field }) => (
                  <th key={spec.key} className={cn('list-head', spec.className)}>
                    {field?.label ?? spec.fallbackLabel}
                  </th>
                ))}
                <th className="list-head w-12 px-0 text-center">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((m, index) => (
                <tr
                  key={m.id}
                  className={cn(
                    'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                    // Ticking a row is how you choose what to send. Without a
                    // mark on the row itself the only feedback was the count on
                    // the Share button, which is at the other end of the card.
                    selected.has(m.id) && 'bg-brand-50/60 dark:bg-brand-950/30',
                  )}
                >
                  <td className="list-cell-select">
                    <input
                      type="checkbox"
                      aria-label={`Select ${m.row.label}`}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                      checked={selected.has(m.id)}
                      onChange={(e) => setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(m.id); else next.delete(m.id);
                        return next;
                      })}
                    />
                  </td>
                  <td className="list-cell w-20 whitespace-nowrap"><ScoreChip score={m.score} /></td>
                  {columns.map(({ spec, field }) => (
                    <td key={spec.key} className={cn('list-cell', spec.className)}>
                      {spec.system === 'label' ? (
                        <Link
                          to={`/${targetModule}/${m.id}${returnQuery}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate font-medium text-brand-600 hover:underline dark:text-brand-400"
                        >
                          {m.row.label}
                        </Link>
                      ) : spec.system === 'updatedAt' ? (
                        <span className="whitespace-nowrap text-xs text-muted">
                          {new Date(m.row.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      ) : (
                        <FieldValue
                          field={field!}
                          value={m.row.values[field!.name]}
                          display={m.row.display?.[field!.name]}
                          compact
                        />
                      )}
                    </td>
                  ))}
                  <td className="list-cell px-0 text-center">
                    <button
                      className="btn-ghost p-1.5"
                      title={`Show ${m.row.label} in full`}
                      aria-label={`Show ${m.row.label} in full`}
                      onClick={() => setPeekAt(index)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {peekAt !== null && rows[peekAt] && targetMeta && (
        <MatchPeek
          rows={rows.map((r) => r.row)}
          index={peekAt}
          meta={targetMeta}
          module={targetModule}
          returnQuery={returnQuery}
          onIndex={setPeekAt}
          onClose={() => setPeekAt(null)}
        />
      )}

      {sharing && (
        <ShareMatchesModal
          module={module}
          recordId={id}
          targetModule={targetModule}
          ids={[...selected]}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}

/**
 * One match, in full, without leaving the list.
 *
 * The fields are the target module's first layout section — the same "Basic
 * Information" somebody would see on the record — read-only, because this is a
 * thing you open while deciding who to ring and editing it belongs on the
 * record page.
 *
 * Left and right walk the list. That is the whole reason this exists rather
 * than a link: comparing six units means opening six of them, and a modal you
 * have to close and reopen is the round trip that made people stop looking.
 */
function MatchPeek({
  rows, index, meta, module, returnQuery, onIndex, onClose,
}: {
  rows: RecordEnvelope[];
  index: number;
  meta: ModuleMeta;
  module: string;
  returnQuery: string;
  onIndex: (i: number) => void;
  onClose: () => void;
}): JSX.Element {
  const row = rows[index];

  const { data: layout } = useQuery({
    queryKey: ['layout', module, 'edit'],
    queryFn: () => api.layout(module, 'edit'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  /*
    The record's first section, or its first few fields if it has no layout.

    Deliberately one section and not the whole record: this is a peek, and a
    modal that scrolls is the record page with extra steps.
  */
  const fields = useMemo(() => {
    const blocks = (layout?.config as { blocks?: { fields: string[] }[] } | undefined)?.blocks;
    const names = blocks?.[0]?.fields ?? meta.fields.slice(0, 10).map((f) => f.name);
    const byName = new Map(meta.fields.map((f) => [f.name, f]));
    return names
      .map((n) => byName.get(n))
      .filter((f): f is FieldMeta => Boolean(f) && f!.isActive && f!.displayType !== 'hidden');
  }, [layout, meta.fields]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); onIndex(index - 1); }
      if (e.key === 'ArrowRight' && index < rows.length - 1) { e.preventDefault(); onIndex(index + 1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, rows.length, onIndex]);

  return (
    <Modal
      open
      onClose={onClose}
      title={row.label}
      size="md"
      footer={(
        <>
          <span className="mr-auto text-xs text-muted tnum">{index + 1} of {rows.length}</span>
          <button className="btn-secondary btn-sm" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous match">
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </button>
          <button className="btn-secondary btn-sm" disabled={index >= rows.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next match">
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <Link to={`/${module}/${row.id}${returnQuery}`} target="_blank" rel="noopener noreferrer" className="btn-primary btn-sm">
            Open record
          </Link>
        </>
      )}
    >
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.name} className="flex min-w-0 items-baseline gap-2.5">
            <dt className="w-[38%] max-w-[10rem] shrink-0 truncate text-2xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300" title={field.label}>
              {field.label}
            </dt>
            <dd className="min-w-0 flex-1 text-sm text-slate-900 dark:text-slate-100">
              <FieldValue field={field} value={row.values[field.name]} display={row.display?.[field.name]} compact />
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-2xs text-muted">Use ← and → to move through the matches.</p>
    </Modal>
  );
}

/**
 * A link to the picked matches, for somebody outside the CRM.
 *
 * Shares the selection, not the search: what a customer receives is the six
 * units their agent chose, not a live query that could show them something
 * else tomorrow. Revoking is on the record's own share list.
 */
function ShareMatchesModal({
  module, recordId, targetModule, ids, onClose,
}: {
  module: string; recordId: string; targetModule: string; ids: string[]; onClose: () => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');

  /*
    Whether this module has been set up for sharing at all.

    Read from the same admin config the public page enforces, rather than
    assumed from the module's name — which is what this used to do, and what
    made "you cannot share people" a rule in the code instead of a decision the
    business gets to make.
  */
  const { data: shareConfig } = useQuery({
    queryKey: ['share-config', targetModule],
    queryFn: () => api.shareLinkConfig(targetModule),
    staleTime: 5 * 60_000,
  });
  const shareable = (shareConfig?.fields ?? []).some((f) => f.visible);
  const targetLabel = targetModule === 'leads' ? 'Leads' : 'Inventory';

  const create = useMutation({
    mutationFn: () => api.shareMatches(module, recordId, { targetModule, ids, label: label.trim() || undefined }),
    onSuccess: (res) => {
      // Built here, from the origin the person is standing on. `APP_URL` on
      // the server is a comma-separated list of every origin this CRM answers
      // on, so it cannot name the right one — the same reason the property
      // share links build their URL in the browser.
      setUrl(`${window.location.origin}/m/${res.token}`);
      if (res.withheld > 0) {
        toast.info(
          `${res.withheld} left out`,
          'Your role does not let you share those, so the link shows the rest.',
        );
      }
    },
    onError: (e: Error) => toast.error('Could not make a link', e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Share ${ids.length} ${ids.length === 1 ? 'match' : 'matches'}`}
      size="md"
      footer={(
        <>
          <button className="btn-secondary" onClick={onClose}>Close</button>
          {!url && shareable && (
            <button className="btn-primary" onClick={() => create.mutate()} disabled={create.isPending || !ids.length}>
              {create.isPending ? 'Making the link…' : 'Make a link'}
            </button>
          )}
        </>
      )}
    >
      {!shareable ? (
        /*
          Nothing has been ticked for this module, so there is nothing to send.

          Both modules can be shared now — an admin decides field by field in
          Admin → Data Sharing what somebody outside the CRM may read, and the
          server refuses a phone, an email or an owner before that list is even
          drawn. Until somebody has made that decision, a link would open on a
          page of empty cards, which tells the recipient there is something
          here and shows them none of it.
        */
        <p className="text-sm">
          Nobody has said yet what an outsider may see of {targetLabel.toLowerCase()}.
          An administrator sets that in Admin → Data Sharing, field by field; until then
          there is nothing to put behind a link.
        </p>
      ) : url ? (
        <div>
          <p className="text-sm">Anyone with this link can see these {ids.length} — no sign-in needed.</p>
          <div className="mt-2 flex gap-2">
            <input className="input flex-1 text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
            <button
              className="btn-secondary btn-sm"
              onClick={() => { void navigator.clipboard?.writeText(url); toast.success('Link copied'); }}
            >
              Copy
            </button>
          </div>
          <p className="mt-2 text-2xs text-muted">
            Revoke it any time from the record’s share links.
          </p>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="share_label">What to call it (optional)</label>
          <input
            id="share_label"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Options for Mr Sharma"
          />
          <p className="mt-2 text-xs text-muted">
            The person you send this to sees the {ids.length} you ticked and nothing else — no prices you
            have not published, no other customer, and nothing that changes after you send it.
          </p>
        </div>
      )}
    </Modal>
  );
}

export default MatchingTab;
