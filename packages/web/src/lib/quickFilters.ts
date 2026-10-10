/**
 * The Quick & Live Filters panel, as data.
 *
 * **1 October 2026, the owner:** every section folds, long lists show their top
 * five with a search, money and size are min–max sliders, dates have
 * Today / Yesterday / This week / This month and a date picker — and all of it
 * arranged in Admin → Quick Filters so it never needs asking for again.
 *
 * Pure, so a `node` test can read every rule here: which sections a module
 * gets when nobody has arranged it, how a saved arrangement meets a field
 * added since, and what each choice turns into in the filter grammar the list
 * already speaks.
 */
import type { FieldMeta, FilterCondition, FilterGroup, QuickFilterKind, QuickFilterSection } from '@ipropy/shared';
import type { DispositionPick } from '../components/CallDispositionFilter';
import type { TaskQueue } from '../components/FollowUpQueue';

/** A date question: one of the presets, or one day picked on the calendar. */
export type DatePreset = 'yesterday' | 'today' | 'this_week' | 'this_month';
export const DATE_PRESETS: Array<[DatePreset, string]> = [
  ['yesterday', 'Yesterday'], ['today', 'Today'], ['this_week', 'This week'], ['this_month', 'This month'],
];

/**
 * The choice that means *"nobody filled this in"*.
 *
 * **3 October 2026, the owner:** *"in the quick & Live filter we need unfilled
 * Data of the form, which are not filled by my agent, i want to see those dat
 * as empty/none in the filter list with record count."*
 *
 * It rides in the same `values` list as the real options, because that is how
 * the panel, the counts and the ticking already work — one list, one tick, one
 * count. It is a **sentinel**, not a value anybody can store: no picklist
 * option may be blank, and `coerceValue` writes `''` for "cleared", so this
 * string can never collide with something a rep actually chose.
 */
export const EMPTY_PICK = '__ipropy_empty__';

/** What somebody has chosen in one field section. */
export type QuickPick =
  | { kind: 'values'; values: string[] }
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'date'; preset?: DatePreset; on?: string };

/** Field name → what is chosen in it. */
export type QuickPicks = Record<string, QuickPick>;

/**
 * The tag section's key.
 *
 * Named here rather than typed as `'tags'` in four files: it is both a section
 * key and the thing `quickPickConditions` recognises to write `record_tags`
 * instead of a field, and those two must never drift apart.
 */
export const TAGS_KEY = 'tags';

/** The record's own dates: every module has them, and neither is a field row. */
export const SYSTEM_DATES: Array<{ key: string; label: string }> = [
  { key: 'created_at', label: 'Created date' },
  { key: 'updated_at', label: 'Updated date' },
];

const RANGE_TYPES = new Set(['currency', 'area', 'number', 'integer', 'decimal', 'percent']);
const VALUE_TYPES = new Set(['picklist', 'multipicklist']);
const DATE_TYPES = new Set(['date', 'datetime']);

/** Which control a field is drawn as, or null when it has none here. */
export function kindForField(field: FieldMeta): QuickFilterKind | null {
  if (VALUE_TYPES.has(field.uitype)) return 'values';
  if (RANGE_TYPES.has(field.uitype)) return 'range';
  if (DATE_TYPES.has(field.uitype)) return 'date';
  return null;
}

/** The fields the list's own sections already cover, so they are not offered twice. */
export interface CoveredFields {
  ownerField?: FieldMeta;
  stageField?: FieldMeta;
  taskField?: FieldMeta;
}

function usable(field: FieldMeta): boolean {
  return field.isActive !== false && field.displayType !== 'hidden';
}

/**
 * The panel a module gets when nobody has arranged it.
 *
 * The CRM's own questions first — who, which list, which stage, the last
 * call, when it is due, when it was added and touched — then every field that
 * has a control, money and sizes before lists, in the module's own order. No
 * field is named here: a module is described by its metadata, and the master
 * is where somebody decides which of them matter.
 */
export function defaultQuickSections(fields: FieldMeta[], covered: CoveredFields): QuickFilterSection[] {
  const fixed: QuickFilterSection[] = [
    ...(covered.ownerField ? [{ key: 'agent', kind: 'agent' as const }] : []),
    { key: 'list', kind: 'list' },
    /*
      **Tags, 3 October 2026:** *"need Tag Filter in quick Filter."* Every
      module has tags, so this needs nothing from `covered` — and it is a
      **fixed** section rather than a field, because a tag is not a field: it
      reaches the server as `record_tags`, which is why `quickPickConditions`
      gives this one key its own line.
    */
    { key: TAGS_KEY, kind: 'tags' },
    ...(covered.stageField ? [{ key: 'stage', kind: 'stage' as const }] : []),
    { key: 'calls', kind: 'calls' },
    ...(covered.taskField ? [{ key: 'task', kind: 'task' as const }] : []),
    ...SYSTEM_DATES.map(({ key }) => ({ key, kind: 'date' as const })),
  ];
  const skip = new Set([covered.ownerField?.name, covered.stageField?.name, covered.taskField?.name]);
  const eligible = fields.filter((field) => usable(field) && !skip.has(field.name) && kindForField(field));
  const byKind = (kind: QuickFilterKind): QuickFilterSection[] => eligible
    .filter((field) => kindForField(field) === kind)
    .map((field) => ({ key: field.name, kind }));
  return [...fixed, ...byKind('range'), ...byKind('values'), ...byKind('date')];
}

/**
 * A saved arrangement, laid over what the module has today.
 *
 * The saved order and wording win. A section whose field has since gone is
 * dropped rather than drawn empty, and a field added since is appended — an
 * arrangement made before a field existed cannot have meant to leave it out.
 */
export function arrangeQuickSections(
  saved: QuickFilterSection[] | undefined,
  defaults: QuickFilterSection[],
): QuickFilterSection[] {
  if (!saved?.length) return defaults;
  const available = new Map(defaults.map((section) => [section.key, section]));
  const kept = saved
    .filter((section) => available.has(section.key))
    // The kind comes from the field as it is now; a list turned into a
    // number field must not keep offering ticks.
    .map((section) => ({ ...section, kind: available.get(section.key)!.kind }));
  const mentioned = new Set(kept.map((section) => section.key));
  return [...kept, ...defaults.filter((section) => !mentioned.has(section.key))];
}

/** The heading a section shows. */
export function sectionLabel(section: QuickFilterSection, fields: Map<string, FieldMeta>, stageLabel?: string): string {
  if (section.label?.trim()) return section.label.trim();
  switch (section.key) {
    case 'agent': return 'Agent wise';
    case 'list': return 'List wise';
    case 'stage': return `${stageLabel ?? 'Status'} wise`;
    case 'calls': return 'Call log wise';
    case 'task': return 'Task wise';
    case TAGS_KEY: return 'Tag wise';
    default: break;
  }
  const system = SYSTEM_DATES.find((date) => date.key === section.key);
  if (system) return system.label;
  return fields.get(section.key)?.label ?? section.key;
}

/** Whether a pick narrows anything at all. */
export function pickIsActive(pick: QuickPick | undefined): boolean {
  if (!pick) return false;
  if (pick.kind === 'values') return pick.values.length > 0;
  if (pick.kind === 'range') return pick.min != null || pick.max != null;
  return Boolean(pick.preset || pick.on);
}

/**
 * Midnight to midnight of one local day, as the instants the server compares.
 *
 * A date-time is stored as an instant, so "1 October" in India starts at
 * 18:30 UTC on 30 September. Sending the bare date would be read as UTC and
 * shift every picked day by five and a half hours.
 */
export function localDayBounds(day: string): [string, string] {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(`${day}T23:59:59.999`);
  return [start.toISOString(), end.toISOString()];
}

function dateConditions(field: string, isDateOnly: boolean, pick: Extract<QuickPick, { kind: 'date' }>): FilterCondition[] {
  if (pick.on) {
    if (isDateOnly) return [{ field, operator: 'equals', value: pick.on }];
    const [from, to] = localDayBounds(pick.on);
    return [{ field, operator: 'between', value: from, value2: to }];
  }
  return pick.preset ? [{ field, operator: pick.preset }] : [];
}

/**
 * What one field's chosen values turn into.
 *
 * "Empty" is a different question from "is one of these", so a section with
 * both ticked becomes an **OR** of the two: *status is New or Hot, **or** it
 * was never filled in*. Ticked on its own it is the plain `is_empty`. Writing
 * the two as separate AND conditions would ask for a field that is both a
 * value and blank, which matches nothing — and would read on screen as the
 * filter being broken rather than as the wrong question.
 */
function valueConditions(name: string, values: string[], field: FieldMeta | undefined): FilterCondition | FilterGroup | null {
  const wantsEmpty = values.includes(EMPTY_PICK);
  const real = values.filter((value) => value !== EMPTY_PICK);
  // A multi-choice field holds a list, so it matches on any overlap.
  const operator = field?.uitype === 'multipicklist' ? 'has_any' : 'in';
  const chosen: FilterCondition = { field: name, operator, value: real };
  const blank: FilterCondition = { field: name, operator: 'is_empty' };
  if (!wantsEmpty) return real.length ? chosen : null;
  if (!real.length) return blank;
  return { logic: 'OR', conditions: [chosen, blank] };
}

/** What every field pick turns into, in the list's own filter grammar. */
export function quickPickConditions(picks: QuickPicks, fields: Map<string, FieldMeta>): Array<FilterCondition | FilterGroup> {
  const conditions: Array<FilterCondition | FilterGroup> = [];
  for (const [name, pick] of Object.entries(picks)) {
    if (!pickIsActive(pick)) continue;
    const field = fields.get(name);
    /*
      A tag is not a field on the module, so it cannot be asked for as one: it
      reaches the server as `record_tags` with `has_any`, the same condition the
      tag cards on the top bar send. Sent as a field name the request is refused
      — or worse, silently matches nothing.
    */
    if (name === TAGS_KEY && pick.kind === 'values') {
      const real = pick.values.filter((value) => value !== EMPTY_PICK);
      const tagged: FilterCondition = { field: 'record_tags', operator: 'has_any', value: real };
      const empty: FilterCondition = { field: 'record_tags', operator: 'is_empty' };
      conditions.push(pick.values.includes(EMPTY_PICK)
        ? real.length ? { logic: 'OR', conditions: [tagged, empty] } : empty
        : tagged);
      continue;
    }
    if (pick.kind === 'values') {
      const node = valueConditions(name, pick.values, field);
      if (node) conditions.push(node);
    } else if (pick.kind === 'range') {
      if (pick.min != null) conditions.push({ field: name, operator: 'greater_or_equal', value: pick.min });
      if (pick.max != null) conditions.push({ field: name, operator: 'less_or_equal', value: pick.max });
    } else {
      conditions.push(...dateConditions(name, field?.uitype === 'date', pick));
    }
  }
  return conditions;
}

function conditionCount(filter: FilterGroup): number {
  return filter.conditions.reduce((total, node) => (
    total + ('conditions' in node ? conditionCount(node) : 1)
  ), 0);
}

export function countActiveQuickFilters({ filter, stages, agent, task, disposition, types = [], picks = {} }: {
  filter: FilterGroup;
  stages: string[];
  agent: string | null;
  task: TaskQueue | null;
  disposition: DispositionPick;
  types?: string[];
  picks?: QuickPicks;
}): number {
  return conditionCount(filter)
    + stages.length
    + (agent ? 1 : 0)
    + (task ? 1 : 0)
    + disposition.outcomes.length
    + (disposition.never ? 1 : 0)
    + types.length
    + Object.values(picks).filter(pickIsActive).length;
}

/**
 * The values a long list shows before its search box: those already ticked,
 * then the most common, up to `top`. A ticked value is never hidden behind the
 * search, or somebody could not see what is narrowing their list.
 */
export function topValues<T extends { value: string }>(all: T[], ticked: string[], top: number): T[] {
  const chosen = all.filter((option) => ticked.includes(option.value));
  const rest = all.filter((option) => !ticked.includes(option.value));
  return [...chosen, ...rest.slice(0, Math.max(0, top - chosen.length))];
}

/** Round a slider's ends to a step a person would type. */
/**
 * A number somebody typed into a price or size box, as a number.
 *
 * Nobody types fourteen million five hundred thousand; they type "1.45 cr" or
 * "45 lakh" or "12,00,000". So the Indian units are read — crore, lakh,
 * thousand, in their usual short forms — and commas in either grouping are
 * ignored. Anything else that is not a number answers `undefined`, which the
 * box treats as "no limit" rather than as zero.
 */
export function parseTypedAmount(typed: string): number | undefined {
  const text = typed.trim().toLowerCase().replace(/,/g, '').replace(/₹|rs\.?/g, '').trim();
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lacs|lakh|lakhs|k|thousand)?$/.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  if (unit.startsWith('c')) return Math.round(amount * 10_000_000);
  if (unit.startsWith('l')) return Math.round(amount * 100_000);
  if (unit === 'k' || unit === 'thousand') return Math.round(amount * 1_000);
  return amount;
}

export function sliderStep(min: number, max: number): number {
  const span = Math.max(1, max - min);
  const magnitude = 10 ** Math.floor(Math.log10(span / 100));
  return Math.max(1, magnitude);
}
