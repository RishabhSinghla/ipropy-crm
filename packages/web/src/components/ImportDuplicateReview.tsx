import { type JSX, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, GitMerge, SkipForward, UserPlus } from 'lucide-react';
import { api, type ImportDuplicatePair, type ImportFieldComparison, type ImportResolution } from '../lib/api';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';
import { EmptyState, Modal, Spinner } from './ui';

/**
 * Deciding, one collision at a time, what to do about a row that is already
 * in the CRM.
 *
 * The screen is deliberately one pair at a time rather than a list of
 * hundreds. A merge is a judgement about two specific people — this Deepak
 * Bansal and that one — and the question it asks ("is the sheet's budget
 * newer than the CRM's?") cannot be answered from a summary row. Bulk answers
 * exist for the case where the judgement is about the *file* rather than the
 * rows ("this is a re-import, skip the lot"), and they sit at the top where
 * they belong.
 *
 * Defaults are chosen so that pressing Merge without touching anything does
 * the safe thing: values the CRM is missing come across, values it already
 * has stay. Only a genuine disagreement — both sides filled in, different —
 * is presented as a choice, and it starts on the existing record.
 */
export function ImportDuplicateReview({
  jobId, fileName, onClose,
}: {
  jobId: string;
  fileName: string;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);
  /** Per pair id, per field: which side wins. Only conflicts are ever in here. */
  const [choices, setChoices] = useState<Record<string, Record<string, 'incoming' | 'existing'>>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['import-duplicates', jobId],
    queryFn: () => api.importDuplicates(jobId),
  });

  const pairs = data?.pairs ?? [];
  const pair: ImportDuplicatePair | undefined = pairs[Math.min(index, Math.max(0, pairs.length - 1))];

  const done = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['import-duplicates', jobId] });
  };

  const resolveOne = useMutation({
    mutationFn: ({ rowId, action }: { rowId: string; action: ImportResolution }) =>
      api.resolveImportDuplicate(jobId, rowId, action, choices[rowId] ?? {}),
    onSuccess: (_result, { action }) => {
      toast.success(
        action === 'merged' ? 'Merged' : action === 'skipped' ? 'Row skipped' : 'Created as a new record',
        action === 'merged' ? 'The existing record now carries the values you kept.' : undefined,
      );
      // Stay on the same index: the answered pair leaves the list, so the next
      // one slides into this position. Stepping forward here would skip it.
      setIndex((i) => Math.min(i, Math.max(0, pairs.length - 2)));
      done();
    },
    onError: (err: Error) => toast.error('Could not apply that', err.message),
  });

  const resolveRest = useMutation({
    mutationFn: (action: ImportResolution) => api.resolveAllImportDuplicates(jobId, action),
    onSuccess: ({ resolved }) => {
      toast.success(`${resolved} handled`, 'Anything that could not be applied is still listed.');
      setIndex(0);
      done();
    },
    onError: (err: Error) => toast.error('Could not apply that', err.message),
  });

  const busy = resolveOne.isPending || resolveRest.isPending;

  const setChoice = (field: string, side: 'incoming' | 'existing'): void => {
    if (!pair) return;
    setChoices((prev) => ({ ...prev, [pair.id]: { ...prev[pair.id], [field]: side } }));
  };

  return (
    <Modal
      open
      size="xl"
      title={`Duplicates in ${fileName}`}
      onClose={onClose}
    >
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : pairs.length === 0 ? (
        <EmptyState
          icon={<Check className="h-10 w-10 text-positive" />}
          title="Every duplicate has been dealt with"
          body="Nothing from this file is waiting on you."
          action={<button className="btn-primary btn-sm" onClick={onClose}>Close</button>}
        />
      ) : pair ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <button
                className="btn-secondary btn-sm"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                aria-label="Previous duplicate"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-1 text-xs text-muted tnum">
                {index + 1} of {pairs.length}
              </span>
              <button
                className="btn-secondary btn-sm"
                disabled={index >= pairs.length - 1}
                onClick={() => setIndex((i) => Math.min(pairs.length - 1, i + 1))}
                aria-label="Next duplicate"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <p className="text-xs text-muted">
              Sheet row {pair.rowNumber}
              {pair.matchedOn.length > 0 && <> · matched on <strong className="font-medium">{pair.matchedOn.join(' and ')}</strong></>}
            </p>

            {/* The whole-file answers. Present because a file that produces a
                hundred collisions is usually a re-import of a file already
                loaded, and clicking through a hundred identical decisions is
                not review — it is data entry. */}
            <div className="ml-auto flex gap-1.5">
              <button
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => resolveRest.mutate('skipped')}
                title="Leave every remaining record exactly as it is in the CRM"
              >
                Skip all {pairs.length}
              </button>
              <button
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => resolveRest.mutate('merged')}
                title="For every remaining row, fill in the blanks the CRM has and leave the rest alone"
              >
                Merge all {pairs.length}
              </button>
            </div>
          </div>

          {pair.existingMissing ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              The record this row matched has been deleted, or is not shared with you. There is
              nothing to compare it against and nothing to merge into — bring the row in as a new
              record, or skip it.
            </p>
          ) : (
            <ComparisonTable
              pair={pair}
              choices={choices[pair.id] ?? {}}
              onChoose={setChoice}
            />
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <p className="text-2xs text-muted">
              Merging writes onto the record already in the CRM. Nothing is deleted either way.
            </p>
            <div className="ml-auto flex flex-wrap gap-2">
              <button
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => resolveOne.mutate({ rowId: pair.id, action: 'skipped' })}
              >
                <SkipForward className="h-3.5 w-3.5" /> Skip this row
              </button>
              <button
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => resolveOne.mutate({ rowId: pair.id, action: 'created' })}
                title="They are two different people — bring the sheet's row in as its own record"
              >
                <UserPlus className="h-3.5 w-3.5" /> Not a duplicate — create it
              </button>
              <button
                className="btn-primary btn-sm"
                disabled={busy || pair.existingMissing}
                onClick={() => resolveOne.mutate({ rowId: pair.id, action: 'merged' })}
              >
                {busy ? <Spinner /> : <GitMerge className="h-3.5 w-3.5" />} Merge into existing
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * The two records, field by field.
 *
 * Ordering is the whole point: the fields that actually differ come first,
 * then what the sheet would fill in, then the agreeing ones — collapsed,
 * because thirty rows of "same, same, same" is what hid the two that mattered
 * when this was first drawn in field order.
 */
function ComparisonTable({
  pair, choices, onChoose,
}: {
  pair: ImportDuplicatePair;
  choices: Record<string, 'incoming' | 'existing'>;
  onChoose: (field: string, side: 'incoming' | 'existing') => void;
}): JSX.Element {
  const [showRest, setShowRest] = useState(false);

  // Three buckets, and the order is the argument: what disagrees, then what the
  // sheet would add, then everything the decision does not turn on.
  const { conflicts, gaps, rest } = useMemo(() => ({
    conflicts: pair.fields.filter((f) => f.conflict),
    gaps: pair.fields.filter((f) => f.fillsGap),
    rest: pair.fields.filter((f) => !f.conflict && !f.fillsGap),
  }), [pair]);

  const agreeing = rest.filter((f) => !f.absent).length;
  const shown = [...conflicts, ...gaps, ...(showRest ? rest : [])];

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)_minmax(0,2fr)] gap-px bg-slate-200 text-2xs font-semibold uppercase tracking-wide dark:bg-slate-700">
        <div className="bg-slate-50 px-3 py-2 text-muted dark:bg-slate-800">Field</div>
        <div className="bg-slate-50 px-3 py-2 dark:bg-slate-800">
          <span className="text-muted">In the CRM · </span>
          <span className="normal-case text-slate-700 dark:text-slate-200">{pair.existingLabel}</span>
        </div>
        <div className="bg-slate-50 px-3 py-2 dark:bg-slate-800">
          <span className="text-muted">From the sheet · </span>
          <span className="normal-case text-slate-700 dark:text-slate-200">{pair.incomingLabel}</span>
        </div>
      </div>

      <div className="max-h-[26rem] overflow-y-auto">
        {conflicts.length === 0 && gaps.length === 0 && !showRest && (
          <p className="px-3 py-6 text-center text-xs text-muted">
            The sheet says nothing this record does not already say. Skipping it changes nothing.
          </p>
        )}

        {shown.map((field) => (
          <ComparisonRow
            key={field.name}
            field={field}
            choice={choices[field.name] ?? (field.fillsGap ? 'incoming' : 'existing')}
            onChoose={(side) => onChoose(field.name, side)}
          />
        ))}
      </div>

      {rest.length > 0 && (
        <button
          className="w-full border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-2xs text-muted hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
          onClick={() => setShowRest((v) => !v)}
        >
          {showRest ? 'Hide' : 'Show'} the other {rest.length} field{rest.length === 1 ? '' : 's'}
          {agreeing > 0 && ` — ${agreeing} agree, ${rest.length - agreeing} not in the sheet`}
        </button>
      )}
    </div>
  );
}

function ComparisonRow({
  field, choice, onChoose,
}: {
  field: ImportFieldComparison;
  choice: 'incoming' | 'existing';
  onChoose: (side: 'incoming' | 'existing') => void;
}): JSX.Element {
  const decidable = field.conflict || field.fillsGap;
  const blank = <span className="text-slate-400 dark:text-slate-500">—</span>;

  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)_minmax(0,2fr)] gap-px border-t border-slate-100 bg-slate-100 text-sm first:border-t-0 dark:border-slate-800 dark:bg-slate-800">
      <div className="flex items-center gap-1.5 bg-white px-3 py-2 dark:bg-slate-900">
        <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">{field.label}</span>
        {field.matched && (
          <span className="shrink-0 rounded bg-slate-200 px-1 text-[10px] font-semibold uppercase text-slate-600 dark:bg-slate-700 dark:text-slate-300" title="This is what identified them as the same record">
            match
          </span>
        )}
      </div>

      <SideCell
        value={field.existingDisplay}
        blank={blank}
        selectable={decidable}
        selected={decidable && choice === 'existing'}
        onSelect={() => onChoose('existing')}
      />
      <SideCell
        value={field.incomingDisplay}
        blank={blank}
        selectable={decidable}
        selected={decidable && choice === 'incoming'}
        onSelect={() => onChoose('incoming')}
        hint={field.fillsGap ? 'fills a blank' : field.conflict ? 'differs' : field.absent ? 'not in the sheet' : undefined}
      />
    </div>
  );
}

function SideCell({
  value, blank, selectable, selected, onSelect, hint,
}: {
  value: string | null;
  blank: JSX.Element;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  hint?: string;
}): JSX.Element {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate" title={value ?? undefined}>{value ?? blank}</span>
      {hint && !selected && <span className="shrink-0 text-[10px] uppercase text-muted">{hint}</span>}
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600 dark:text-brand-400" />}
    </>
  );

  if (!selectable) {
    return <div className="flex items-center gap-2 bg-white px-3 py-2 text-slate-600 dark:bg-slate-900 dark:text-slate-400">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-left transition-colors',
        selected
          ? 'bg-brand-50 font-medium text-slate-900 dark:bg-brand-950/50 dark:text-slate-100'
          : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800',
      )}
    >
      {body}
    </button>
  );
}
