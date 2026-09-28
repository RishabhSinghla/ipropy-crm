/**
 * The three facts a call changes, stacked beside the record's face.
 *
 * **28 September 2026, the owner:** *"Move Overdue (11D), Visit Scheduled &
 * Busy in to left side from Avtar in very Light colour as Icon colour of Call,
 * Star, Tag … And Chip size as Similar as Icon size of Call, Star, Tag"*, with
 * *"Actually we need this space compact so that below that much visible to my
 * Team"* as the reason for all of it.
 *
 * They used to be a full-width band under the avatar, which cost the hero a
 * whole row. Stacked in the column the grid already left empty on the left,
 * they cost nothing.
 *
 * **Only three, and none of them is named here.** The chase date and the stage
 * are `useRecordPanes`'s answers, handed in; the call outcome is `HeaderPills`.
 * Contact type and source came off the hero on the same instruction — *"Remove
 * Buyer, Old Leads Icons"* — and they are still on the record's own Overview,
 * which is where a fact nobody changes mid-call belongs.
 *
 * **Colour carries the meaning, lightly.** The chase date wears the queue's own
 * Today / Tomorrow / Pending / Overdue tints (`FOLLOW_UP_STYLE`, shared rather
 * than copied, so the queue and the hero can never disagree about who is late);
 * the stage keeps the admin's own colour as a wash rather than a fill. Nothing
 * here is solid: four solid chips beside a face read as four warnings, which is
 * the same reason the action circles are grey at rest.
 */
import { type JSX } from 'react';
import { picklistOptionForValue, type FieldMeta, type RecordEnvelope } from '@ipropy/shared';
import { type DescribedModule } from '../lib/recordPanes';
import { badgeVars } from '../lib/color';
import { cn } from '../lib/utils';
import { FollowUpChipCell, HeaderChipValue } from './RecordBlocks';
import { HeaderPills } from './HeaderPills';
import { invalidateRecordQueries } from '../lib/invalidate';
import { useQueryClient } from '@tanstack/react-query';

/**
 * The same height as an action circle, so the column beside the face reads as
 * one set of controls rather than two sizes of thing.
 */
const CHIP = 'inline-flex h-8 max-w-[9rem] items-center justify-center rounded-full px-3 text-2xs font-semibold uppercase tracking-wide';

/** The resting look for a chip with no colour of its own. */
/** A stage the admin has given no colour still has to read as a chip, not as
 *  a word floating on the banner. */
const CHIP_PLAIN = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200';

export function HeroStatusChips({ module, row, canEdit, statusField, followUpField, className }: {
  module: DescribedModule;
  row: RecordEnvelope;
  canEdit: boolean;
  statusField?: FieldMeta;
  followUpField?: FieldMeta;
  className?: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const statusColour = statusField
    ? picklistOptionForValue(statusField.options, row.values[statusField.name])?.color
    : null;

  return (
    <span className={cn('flex min-w-0 flex-col items-start gap-1.5', className)}>
      {followUpField && (
        // No wrapper tint: the chip inside carries its own, and a tint under a
        // tint is how "overdue" stopped reading as overdue once already.
        <span title={followUpField.label}>
          <FollowUpChipCell module={module} row={row} field={followUpField} canEdit={canEdit} size="hero" />
        </span>
      )}

      {statusField && (
        <span
          // `badge-tinted`, not `badge`: the base class carries its own padding
          // and size, which would fight CHIP's for the stylesheet's attention.
          // The tinted one sets three colours and nothing else.
          className={cn(CHIP, statusColour ? 'badge-tinted' : CHIP_PLAIN, 'truncate')}
          style={statusColour ? badgeVars(statusColour) : undefined}
          title={statusField.label}
        >
          <HeaderChipValue
            module={module}
            row={row}
            field={statusField}
            canEdit={canEdit}
            asWords
            onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)}
          />
        </span>
      )}

      <HeaderPills module={module} row={row} canEdit={canEdit} />
    </span>
  );
}
