/**
 * The Hot chip on the toolbar: how many records here are tagged hot, and one
 * tap to show only them.
 *
 * **1 October 2026, the owner:** *"remove this [call outcome chip] and replace
 * it with hot lead tag thing along with count so it would show indeed on
 * clicking hot lead tag ones of that module."* The call outcome filter is
 * still in the filter panel; only its chip left the row.
 *
 * It is the module's own **tag** called "hot" (or "hot lead"), found in the
 * tag list rather than created here — production's tag is `hot`, offered on
 * all three modules. A module with no such tag shows no chip, rather than a
 * chip that can only say 0. The count is the tag list's own count of live
 * records on this module, the same number the list picker shows beside it.
 */
import { type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Flame } from 'lucide-react';
import { api } from '../lib/api';
import { toolbarButton, toolbarCount } from '../lib/toolbarButton';

/** "hot", "Hot Lead", "hot leads" — the words this business tags a hot one with. */
export function isHotTagName(name: string): boolean {
  return /^hot(\s+leads?)?$/i.test(name.trim());
}

export function HotTagChip({ moduleName, active, onPick }: {
  moduleName: string;
  /** The tag the list is narrowed to right now, if any. */
  active: string | null;
  onPick: (tag: string | null) => void;
}): JSX.Element | null {
  // The same key the list picker and the tag chips read, so they share a count.
  const { data: tags } = useQuery({
    queryKey: ['tags', moduleName],
    queryFn: () => api.tags(moduleName),
    staleTime: 60_000,
  });
  const hot = (tags ?? []).find((tag) => isHotTagName(tag.name));
  if (!hot) return null;
  const on = active === hot.name;
  return (
    <button
      type="button"
      onClick={() => onPick(on ? null : hot.name)}
      aria-pressed={on}
      title={on ? `Showing only ${hot.name} — tap to show everybody` : `Show only records tagged ${hot.name}`}
      data-testid="hot-tag-chip"
      className={toolbarButton(on)}
    >
      <Flame className="h-3.5 w-3.5 shrink-0" />
      <span className="sr-only">{hot.name}</span>
      <span className={toolbarCount(on)}>{hot.usage_count.toLocaleString('en-IN')}</span>
    </button>
  );
}
