import { useQuery } from '@tanstack/react-query';
import { CALL_DISPOSITIONS } from '@ipropy/shared';
import { api } from './api';

/**
 * The outcomes the call logger offers, from the admin's own list.
 *
 * Both call dialogs rendered `CALL_DISPOSITIONS`, a constant compiled into the
 * bundle. The picklist of the same name is what Settings edits and — since the
 * server started refusing outcomes that are not on it — what a save is checked
 * against, so the two lists had to become one: an outcome added in Settings was
 * unreachable from the dialog, and one deleted there was still offered and
 * would have been refused on save.
 *
 * The constant stays as the fallback, and it is not a stale copy: it is the
 * same array the seed builds the picklist from. It covers the first paint and
 * a network that is not answering yet, which on a phone in a lift is a real
 * state — a rep must never be stopped from recording what happened on a call
 * because a dropdown could not load.
 *
 * `current` keeps a value the list no longer holds selectable, for the same
 * reason `optionsWithValue` exists: a call recorded under an outcome an admin
 * has since deleted must still open, and must not silently change when the
 * dialog is saved.
 */
export function useCallDispositions(current?: string): string[] {
  return useCallDispositionOptions(current).map((option) => option.value);
}

/**
 * The call logger writes stable values, while people should always see the
 * name their admin entered.  Keep both together so every call surface can use
 * the value for saving and the label for reading.
 */
export function useCallDispositionOptions(current?: string): { value: string; label: string }[] {
  const { data } = useQuery({
    queryKey: ['picklist', 'call_disposition'],
    queryFn: () => api.picklist('call_disposition'),
    staleTime: 5 * 60_000,
  });

  const live = (data ?? [])
    .filter((option) => (option as { isActive?: boolean }).isActive !== false)
    .map((option) => ({ value: option.value, label: option.label || option.value }));
  const values = live.length ? live : CALL_DISPOSITIONS.map((value) => ({ value, label: value }));
  return current && !values.some((option) => option.value === current)
    ? [...values, { value: current, label: current }]
    : values;
}
