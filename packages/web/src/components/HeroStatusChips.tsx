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
import type React from 'react';
import { picklistOptionForValue, type FieldMeta, type RecordEnvelope } from '@ipropy/shared';
import { type DescribedModule } from '../lib/recordPanes';
import { badgeVars } from '../lib/color';
import { cn } from '../lib/utils';
import { FollowUpChipCell, HeaderChipValue } from './RecordBlocks';
import { HeaderPills } from './HeaderPills';
import { invalidateRecordQueries } from '../lib/invalidate';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Small, and in a row.
 *
 * **28 September 2026, the owner:** *"Can you alight vertical to horizontal of
 * Next followup, Lead/Inventory Status, call disposition chip in a small chip
 * and in a reduce font size accordingly in all module."* Stacked they were
 * three lines tall beside an 84px face, which set the height of the whole
 * hero; in a row they set none of it.
 */
/*
  Sentence case, not capitals. Three chips have to sit on one line in a column
  that is a third of the panel, and `uppercase tracking-wide` costs about a
  fifth of the width of every one of them for no fact the words do not already
  carry.
*/
const CHIP = 'inline-flex h-6 max-w-[6.5rem] items-center justify-center rounded-full px-2 text-[10px] font-semibold';

/** The resting look for a chip with no colour of its own. */
/** A stage the admin has given no colour still has to read as a chip, not as
 *  a word floating on the banner. */
const CHIP_PLAIN = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200';

/**
 * The field's own name, printed in front of its chip.
 *
 * **28 September 2026, the owner:** *"Add Key Field name before Key fields
 * Value in Middle Pane Header before Follow-up, Status, Call Disposition from
 * All modules."* A row of three bare words — `Tomorrow`, `New`, `Busy` — says
 * nothing about which is which until you already know the screen, and a new
 * rep does not.
 *
 * **It is the field's own label**, so a module that calls its stage
 * "Associate Status" says so and a rename in the Field Manager reaches this
 * header the same afternoon. No screen names a field.
 */
function KeyLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {children}
    </span>
  );
}

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
    // A row that wraps rather than one that overflows: at a narrow pane the
    // third chip drops under the first two instead of leaving the panel.
    <span data-testid="hero-chips" className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {followUpField && (
        // No wrapper tint: the chip inside carries its own, and a tint under a
        // tint is how "overdue" stopped reading as overdue once already.
        <span className="inline-flex min-w-0 items-center gap-1" title={followUpField.label}>
          <KeyLabel>{followUpField.label}</KeyLabel>
          <FollowUpChipCell module={module} row={row} field={followUpField} canEdit={canEdit} size="hero" />
        </span>
      )}

      {statusField && (
        <span className="inline-flex min-w-0 items-center gap-1">
        <KeyLabel>{statusField.label}</KeyLabel>
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
        </span>
      )}

      <span className="inline-flex min-w-0 items-center gap-1">
        {/* The call pill's own word. It is not a field on the module — an
            outcome lives on `ipy_call` — so this is the one label here that
            is not read from metadata, and it is the owner's own wording for
            the toolbar button that filters on it. */}
        <KeyLabel>Call Log</KeyLabel>
        <HeaderPills module={module} row={row} canEdit={canEdit} size="hero" />
      </span>
    </span>
  );
}
