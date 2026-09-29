/**
 * "Show me everybody whose last call went like this."
 *
 * **27 September 2026, the owner:** *"And we need a call Disposition Filter
 * Button Also after Followup Button in Toolbar"* — in both modules.
 *
 * **A disposition is not a field on the record**, and that is the whole reason
 * this took a change on the server. It lives on `ipy_call`, one row per call,
 * so the list had no way to be asked the question at all. `last_call_at` and
 * `last_call_disposition` are system fields in the query builder now, which
 * means this button, a saved view, a dashboard widget and the queue's own
 * sorting all ask it the same way rather than four ways.
 *
 * The outcomes offered are the admin's own picklist, through the same
 * `useCallDispositionOptions` the call deck reads — never a list written here,
 * or an outcome added in Settings would be unfilterable.
 *
 * No counts beside each outcome, deliberately: seventeen count queries to open
 * a dropdown is seventeen round trips for a number nobody asked for.
 */
import { type JSX } from 'react';
import { Check, PhoneOutgoing } from 'lucide-react';
import { Dropdown } from './ui';
import { useCallDispositionOptions } from '../lib/callDispositions';
import { toolbarButton, toolbarCount } from '../lib/toolbarButton';
import { cn } from '../lib/utils';

/** The filter field, so the list and this button cannot name it differently. */
export const LAST_CALL_DISPOSITION = 'last_call_disposition';

/** Chosen outcomes, or `never` for records nobody has rung at all. */
export type DispositionPick = { outcomes: string[]; never: boolean };

export const NO_DISPOSITION_PICK: DispositionPick = { outcomes: [], never: false };

export function dispositionIsOn(pick: DispositionPick): boolean {
  return pick.never || pick.outcomes.length > 0;
}

export function CallDispositionFilter({ pick, onPick }: {
  pick: DispositionPick;
  onPick: (pick: DispositionPick) => void;
}): JSX.Element {
  const outcomes = useCallDispositionOptions();
  const on = dispositionIsOn(pick);

  const toggle = (value: string): void => {
    const already = pick.outcomes.includes(value);
    onPick({
      never: false,
      outcomes: already ? pick.outcomes.filter((v) => v !== value) : [...pick.outcomes, value],
    });
  };

  return (
    <Dropdown
      align="left"
      className="w-72"
      trigger={
        <button
          type="button"
          title="Filter by how the last call went"
          data-testid="call-disposition-filter"
          className={toolbarButton(on)}
        >
          <PhoneOutgoing className="h-3.5 w-3.5 shrink-0" />
          {/* *"Call Disposition to Call Log"*, 28 September 2026. */}
          Call Log
          <span className={toolbarCount()}>
            {pick.never ? 'Never called' : pick.outcomes.length ? `${pick.outcomes.length} picked` : outcomes.length}
          </span>
        </button>
      }
    >
      {() => (
        <div className="max-h-[22rem] overflow-y-auto py-1">
          <Row label="Any call outcome" chosen={!on} onClick={() => onPick(NO_DISPOSITION_PICK)} />
          {/* Its own row rather than an outcome, because "nobody has rung them"
              is the absence of a call and not something a call said. */}
          <Row
            label="Never called"
            chosen={pick.never}
            onClick={() => onPick({ outcomes: [], never: !pick.never })}
          />
          <p className="px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wide text-slate-400">
            Last call was
          </p>
          {outcomes.map((outcome) => (
            <Row
              key={outcome.value}
              label={outcome.label}
              chosen={pick.outcomes.includes(outcome.value)}
              onClick={() => toggle(outcome.value)}
            />
          ))}
        </div>
      )}
    </Dropdown>
  );
}

/** One line of the list. Stays open on a click — picking three is one visit. */
function Row({ label, chosen, onClick }: { label: string; chosen: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={chosen}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        chosen
          ? 'bg-brand-50 font-bold text-brand-900 dark:bg-brand-950/50 dark:text-brand-100'
          : 'font-medium text-slate-700 hover:bg-[var(--surface-muted)] dark:text-slate-200',
      )}
    >
      <Check className={cn('h-3.5 w-3.5 shrink-0', chosen ? 'text-brand-600' : 'invisible')} />
      <span className="truncate">{label}</span>
    </button>
  );
}
