/**
 * The two pills beside a record's name: where it stands, and how the last
 * call went.
 *
 * **26 September 2026, the owner**, of both modules: *"From the Left of Icon
 * Star/Favourite i need these button on both module buy side by side"* — one
 * carrying the module's own status, *"colour Picked from Leads/Inventory
 * Status Dropdown Colour"*, and one for calling back, *"Colour Always Fix
 * With Dark Purple as theme button"*. Both show a dropdown arrow and open the
 * list behind them.
 *
 * **No screen names a field here either.** The status pill is whatever
 * `pipelineFieldOf` says this module's stage field is — Lead Status on a
 * contact, Property Status on a unit — and its options and their colours come
 * off that field's own metadata, so an admin who adds a stage or recolours one
 * sees it here the same afternoon. The call pill reads the admin's own
 * `call_disposition` list through `useCallDispositions`, which is the list the
 * server checks a save against.
 *
 * One component, used by the split view and the record page, so the two cannot
 * drift into showing different things in the same place.
 */
import { type JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import type { FieldMeta, RecordEnvelope } from '@ipropy/shared';
import { Dropdown, DropdownItem } from './ui';
import { api } from '../lib/api';
import { useCallDispositions } from '../lib/callDispositions';
import { followUpFor } from '../lib/callConsole';
import { invalidateRecordQueries } from '../lib/invalidate';
import { HEADER_CHIP_SHAPE, HEADER_CHIP_SHAPE_SM, HEADER_CHIP_TONE } from '../lib/headerChip';
import { type DescribedModule, useRecordPanes } from '../lib/recordPanes';
import { toast } from '../lib/store';
import { cn } from '../lib/utils';

export function HeaderPills({ module, row, canEdit, className, size = 'row' }: {
  module: DescribedModule;
  row: RecordEnvelope;
  canEdit: boolean;
  className?: string;
  /** `hero` is the small chip in the record header's row beside the face. */
  size?: 'row' | 'hero';
}): JSX.Element {
  /*
    The call pill alone.

    **27 September 2026, the owner:** *"in the header pane we have a
    button/chip of Lead/Inventory Status Before Star Button, Please remove the
    Lead/Inventory Status from Header Pane."* The stage moved to the queue
    card's own corner the same day, where the star used to be — so it is on
    screen for every record in the list rather than only the open one, and
    showing it twice on the open one was the duplication he was looking at.

    The editable stage chip went with it rather than being left here unused —
    git remembers it, and dead code with a comment explaining why it is dead
    is the thing the next reader has to work out before they can ignore it.
  */
  const { followUpField } = useRecordPanes(module);
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5', className)}>
      <CallAgainPill module={module} followUp={followUpField} row={row} canEdit={canEdit} size={size} />
    </span>
  );
}

/**
 * How the last call went, and one tap to record how this one did.
 *
 * **It wears the header's own chip now** (`HEADER_CHIP`, 28 September 2026):
 * light, round, a hairline border, bold — the same as the contact type and
 * the source beside it, because he asked for the whole header to read as one
 * set with the stage as the single exception. It was dark purple on his
 * instruction of 26 September; that is the earlier of the two and this is the
 * later one.
 *
 * Choosing an outcome writes a call the ordinary way, through the same
 * `logCall` the call deck saves with, and lets the outcome set the chase date
 * through `followUpFor` — which never overwrites a date somebody has already
 * put in the future. So a rep who rang from their own handset records what
 * happened without opening anything.
 */
function CallAgainPill({ module, followUp, row, canEdit, size = 'row' }: {
  module: DescribedModule; followUp: FieldMeta | undefined; row: RecordEnvelope; canEdit: boolean;
  size?: 'row' | 'hero';
}): JSX.Element {
  const queryClient = useQueryClient();
  // The same key and the same request the record's Calls tab uses, so opening
  // one warms the other and a call recorded here shows there immediately.
  const { data: calls } = useQuery({
    queryKey: ['record-calls', row.id],
    queryFn: () => api.calls({ recordId: row.id, limit: 1 }),
    staleTime: 30_000,
  });
  const last = (calls ?? [])[0] as { disposition?: string | null } | undefined;
  const outcomes = useCallDispositions(last?.disposition ?? undefined);

  const record = useMutation({
    mutationFn: async (outcome: string) => {
      await api.logCall({
        recordId: row.id,
        module: module.name,
        direction: 'outbound',
        durationSeconds: 0,
        disposition: outcome,
      });
      // The outcome chases them for you, and never argues with a date that is
      // already in the future — the same rule the call deck saves under.
      const chaseOn = followUp
        ? followUpFor(outcome, (row.values[followUp.name] as string | null | undefined) ?? null, new Date())
        : null;
      if (chaseOn && followUp) await api.update(module.name, row.id, { [followUp.name]: chaseOn });
      return chaseOn;
    },
    onSuccess: (chaseOn) => {
      invalidateRecordQueries(queryClient, module.name, row.id);
      void queryClient.invalidateQueries({ queryKey: ['record-calls', row.id] });
      void queryClient.invalidateQueries({ queryKey: ['calls'] });
      toast.success('Call recorded', chaseOn ? 'Follow-up scheduled.' : 'One conversation moved forward.');
    },
    onError: (err: Error) => toast.error('Could not record the call', err.message),
  });

  const label = last?.disposition ? String(last.disposition) : 'Call Again';

  return (
    <Dropdown
      align="right"
      trigger={
        <button
          type="button"
          disabled={!canEdit || record.isPending}
          data-testid="call-again-pill"
          title={last?.disposition ? `Last call: ${label} — record another` : 'Record how a call went'}
          aria-label={last?.disposition ? `Last call ${label}. Record how a call went` : 'Record how a call went'}
          className={cn(
            'inline-flex max-w-[12rem]',
            // Swapped whole rather than layered: `cn` is plain clsx, so a
            // second `px-*` beside this one would be decided by Tailwind's own
            // stylesheet order rather than by which was written last.
            size === 'hero' ? 'gap-1 px-2' : 'gap-1.5 px-3.5',
            size === 'hero' ? HEADER_CHIP_SHAPE_SM : HEADER_CHIP_SHAPE,
            HEADER_CHIP_TONE,
            // A light chip brightens on hover. It used to darken to charcoal,
            // which was right while these were solid and is not any more.
            'transition-colors hover:bg-brand-100 dark:hover:bg-brand-900 active:scale-95',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <PhoneCall className={cn('shrink-0', size === 'hero' ? 'h-3 w-3' : 'h-4 w-4')} aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      }
    >
      {(close) => (
        <>
          {outcomes.map((outcome) => (
            <DropdownItem key={outcome} onClick={() => { close(); record.mutate(outcome); }}>
              {outcome}
            </DropdownItem>
          ))}
        </>
      )}
    </Dropdown>
  );
}
