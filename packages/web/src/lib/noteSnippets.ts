/**
 * The one-tap phrases under a notes box, from the admin's own dropdown.
 *
 * **27 September 2026, the owner**, of the three chips his prototype drew:
 * *"yes make those chips editable from a dropdown"*. So there is no list of
 * phrases in this file — `note_snippet` is an ordinary picklist, edited in
 * Admin → Dropdowns like Lead Source or Call Disposition, and a phrase added
 * there is on every notes box the same afternoon.
 *
 * **No compiled-in fallback, deliberately.** `useCallDispositions` keeps one
 * because a rep must never be stopped from recording what happened on a call
 * by a dropdown that has not loaded; these are a convenience, and inventing
 * three phrases when the list is unreachable would put words this business
 * never chose in front of a customer's record. An empty list simply shows no
 * chips.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export function useNoteSnippets(): string[] {
  const { data } = useQuery({
    queryKey: ['picklist', 'note_snippet'],
    queryFn: () => api.picklist('note_snippet'),
    staleTime: 5 * 60_000,
  });
  return (data ?? [])
    .filter((option) => (option as { isActive?: boolean }).isActive !== false)
    .map((option) => option.label || option.value)
    .filter((phrase) => phrase.trim().length > 0);
}

/**
 * What the note reads after a phrase is tapped.
 *
 * Pure, so a `node` test can walk it without a browser. Three rules, and each
 * one is a thing a rep would otherwise have to undo by hand:
 *
 *  * a phrase goes on **its own line**, so two taps do not run together into a
 *    sentence nobody wrote;
 *  * **tapping the same phrase twice adds nothing** — the chips are a way to
 *    write faster, and a note saying "Price negotiable" twice is a note
 *    somebody has to edit;
 *  * an empty note starts with the phrase rather than a blank first line.
 */
export function appendSnippet(note: string, phrase: string): string {
  const clean = phrase.trim();
  if (!clean) return note;
  const lines = note.split('\n').map((line) => line.trim());
  if (lines.includes(clean)) return note;
  return note.trim() ? `${note.replace(/\s+$/, '')}\n${clean}` : clean;
}
