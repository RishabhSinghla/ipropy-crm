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
 * **1 October 2026:** the chip left the toolbar for the Hot chip, on the
 * owner's instruction. The question is still asked from the filter panel
 * (`QuickFilterOverlay`), so only the shape of the pick lives here now.
 */

/** The filter field, so the list and this button cannot name it differently. */
export const LAST_CALL_DISPOSITION = 'last_call_disposition';

/** Chosen outcomes, or `never` for records nobody has rung at all. */
export type DispositionPick = { outcomes: string[]; never: boolean };

export const NO_DISPOSITION_PICK: DispositionPick = { outcomes: [], never: false };

export function dispositionIsOn(pick: DispositionPick): boolean {
  return pick.never || pick.outcomes.length > 0;
}
