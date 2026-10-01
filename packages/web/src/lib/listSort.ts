/**
 * What a list can be sorted by, as data.
 *
 * **27 September 2026, the owner:** *"I need Nothing by default means when we
 * Filter the data, The data have no sorting option by Default … and when we
 * want Sorting, Then the option we can choose 'Recently Update, Recently
 * create, Agent wise, Created by, updating By, Last Call Wise, Profile
 * Strength Wise, Task Wise' all sorting feature works well with A-Z and Z-A
 * functionality else should be delete i.e Name, House, Portion, category,
 * Locality, Lead/Property Status."*
 *
 * So the menu used to be built out of the module's own fields — one row per
 * subtitle field, plus the name and the stage — which is a list that grows
 * every time an admin flags a field and asks a rep to guess what "Locality
 * A–Z" is for. These eight are questions somebody actually has, they are the
 * same eight in both modules, and each one is one row with one direction.
 *
 * **1 October 2026:** "No sorting" is gone, on the owner's instruction, and a
 * list nobody has sorted is Recently updated, newest first — which is also
 * what the server answers when no order is named.
 *
 * Pure, so a `node` test reads it without the store: what matters here is that
 * Recently updated is the default, that every option carries a direction, and
 * that the two the modules name for themselves — the task date — are found
 * through metadata rather than written down.
 */

/** One row of the sort menu. */
export interface SortOption {
  key: string;
  label: string;
  /** What the server is asked to order by. */
  by: string;
  /** What A–Z and Z–A mean for this one, for the hover. */
  ascHint: string;
  descHint: string;
}

const NEWEST = 'Newest first';
const OLDEST = 'Oldest first';

/**
 * The menu for one module.
 *
 * `taskField` is the module's own follow-up field, found by the caller through
 * `useRecordPanes` — no screen names a field, and the two modules have called
 * that column two different things for as long as the CRM has existed.
 */
export function sortOptions(taskField?: string): SortOption[] {
  const options: SortOption[] = [
    { key: 'updated', label: 'Recently updated', by: 'updated_at', ascHint: OLDEST, descHint: NEWEST },
    { key: 'created', label: 'Recently created', by: 'created_at', ascHint: OLDEST, descHint: NEWEST },
    { key: 'agent', label: 'Agent wise', by: 'owner_id', ascHint: 'Agent name A–Z', descHint: 'Agent name Z–A' },
    { key: 'createdBy', label: 'Created by', by: 'created_by', ascHint: 'Name A–Z', descHint: 'Name Z–A' },
    { key: 'updatedBy', label: 'Updated by', by: 'modified_by', ascHint: 'Name A–Z', descHint: 'Name Z–A' },
    { key: 'lastCall', label: 'Last call wise', by: 'last_call_at', ascHint: 'Longest since a call', descHint: 'Called most recently' },
    { key: 'strength', label: 'Profile strength wise', by: 'profile_strength', ascHint: 'Emptiest first', descHint: 'Fullest first' },
  ];
  // A module with no follow-up field has no task to sort by, so the row is not
  // offered rather than offered and dead.
  if (taskField) {
    options.push({ key: 'task', label: 'Task wise', by: taskField, ascHint: 'Soonest due first', descHint: 'Furthest away first' });
  }
  return options;
}

/**
 * Which row of the menu is on, given what the list is actually sorted by.
 *
 * Nothing chosen is the first row, Recently updated — the server's own default.
 * A column heading somebody clicked in the table view is none of these — the
 * table sorts by its own columns and always has — so that answers null and the
 * button says which field it is instead of claiming one of these eight.
 */
export function activeSortOption(options: SortOption[], sortBy: string | undefined): SortOption | null {
  if (!sortBy) return options[0] ?? null;
  return options.find((option) => option.by === sortBy) ?? null;
}
