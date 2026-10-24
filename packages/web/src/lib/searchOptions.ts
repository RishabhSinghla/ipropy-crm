/** The pure half of the searchable drop-down, kept apart from React so a node test can read it. */

export interface SelectOption {
  value: string;
  label: string;
  /** Extra words this option can be found by, which are not shown. */
  keywords?: string;
}

/** The options that contain every word typed, in their own order. An empty search keeps all of them. */
export function filterOptions(options: SelectOption[], search: string): SelectOption[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((option) => {
    const haystack = `${option.label} ${option.keywords ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Where the highlight lands after an arrow key: it stops at both ends rather than wrapping past them. */
export function moveHighlight(current: number, step: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return Math.min(count - 1, Math.max(0, current + step));
}
