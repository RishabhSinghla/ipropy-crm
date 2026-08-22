/**
 * Field "uitypes" — the vocabulary the whole CRM is built on.
 *
 * Directly inspired by Vtiger's numeric `uitype` column, but named instead of
 * numbered so metadata stays readable. Every uitype declares how a value is
 * stored, validated, filtered and rendered. Adding a new uitype here makes it
 * immediately available in the admin field builder, the dynamic form renderer,
 * the list view, the filter builder and the workflow engine.
 */

export type StorageKind =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'
  | 'uuid';

export type UIType =
  // --- text ---------------------------------------------------------------
  | 'string'
  | 'textarea'
  | 'richtext'
  | 'email'
  | 'phone'
  | 'url'
  | 'password'
  // --- numeric ------------------------------------------------------------
  | 'integer'
  | 'decimal'
  | 'currency'
  | 'percent'
  | 'area' // sq.ft / sq.m — real-estate specific
  // --- choice -------------------------------------------------------------
  | 'picklist'
  | 'multipicklist'
  | 'boolean'
  // --- temporal -----------------------------------------------------------
  | 'date'
  | 'datetime'
  | 'time'
  // --- relational ---------------------------------------------------------
  | 'reference' // FK to another module's record
  | 'multireference'
  | 'owner' // user or group
  | 'user'
  // --- composite ----------------------------------------------------------
  | 'address'
  | 'geolocation'
  | 'file'
  | 'image'
  | 'tags'
  | 'json'
  // --- computed -----------------------------------------------------------
  | 'autonumber'
  | 'formula'
  | 'rollup'
  | 'score'; // 0-100 AI/rule driven score

export interface UITypeSpec {
  /** Physical storage shape used by the query builder and migrations. */
  storage: StorageKind;
  /** Human label shown in the admin field builder. */
  label: string;
  /** Grouping in the field-type picker. */
  group: 'Text' | 'Number' | 'Choice' | 'Date & Time' | 'Relationship' | 'Advanced' | 'Computed';
  /** Filter operators offered for this type. */
  operators: FilterOperator[];
  /** Value cannot be typed by a user — engine computes it. */
  computed?: boolean;
  /** Can be used as a list-view column. */
  listable?: boolean;
  /** Participates in full-text search. */
  searchable?: boolean;
  /** Can be aggregated in dashboards/reports. */
  aggregatable?: boolean;
  /** Needs an entry in field.config (e.g. picklist name, target module). */
  requiresConfig?: (keyof FieldConfig)[];
  icon: string;
}

export type FilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'greater_than'
  | 'greater_or_equal'
  | 'less_than'
  | 'less_or_equal'
  | 'between'
  | 'in'
  | 'not_in'
  | 'is_true'
  | 'is_false'
  | 'today'
  | 'tomorrow'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'this_quarter'
  | 'this_year'
  | 'last_n_days'
  | 'next_n_days'
  | 'older_than_n_days'
  | 'is_me'
  | 'is_my_team'
  | 'has_any'
  | 'has_all';

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  greater_than: 'greater than',
  greater_or_equal: 'greater than or equal',
  less_than: 'less than',
  less_or_equal: 'less than or equal',
  between: 'between',
  in: 'is one of',
  not_in: 'is none of',
  is_true: 'is checked',
  is_false: 'is unchecked',
  today: 'is today',
  tomorrow: 'is tomorrow',
  yesterday: 'was yesterday',
  this_week: 'is this week',
  this_month: 'is this month',
  this_quarter: 'is this quarter',
  this_year: 'is this year',
  last_n_days: 'in the last N days',
  next_n_days: 'in the next N days',
  older_than_n_days: 'older than N days',
  is_me: 'is me',
  is_my_team: 'is my team',
  has_any: 'has any of',
  has_all: 'has all of',
};

const TEXT_OPS: FilterOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
];

const NUM_OPS: FilterOperator[] = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'between',
  'is_empty',
  'is_not_empty',
];

const DATE_OPS: FilterOperator[] = [
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'between',
  'today',
  'tomorrow',
  'yesterday',
  'this_week',
  'this_month',
  'this_quarter',
  'this_year',
  'last_n_days',
  'next_n_days',
  'older_than_n_days',
  'is_empty',
  'is_not_empty',
];

const CHOICE_OPS: FilterOperator[] = ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty'];

export const UITYPES: Record<UIType, UITypeSpec> = {
  string: {
    storage: 'text', label: 'Single Line Text', group: 'Text', operators: TEXT_OPS,
    listable: true, searchable: true, icon: 'type',
  },
  textarea: {
    storage: 'text', label: 'Multi Line Text', group: 'Text', operators: TEXT_OPS,
    listable: true, searchable: true, icon: 'align-left',
  },
  richtext: {
    storage: 'text', label: 'Rich Text', group: 'Text', operators: TEXT_OPS,
    searchable: true, icon: 'file-text',
  },
  email: {
    storage: 'text', label: 'Email', group: 'Text', operators: TEXT_OPS,
    listable: true, searchable: true, icon: 'mail',
  },
  phone: {
    storage: 'text', label: 'Phone', group: 'Text', operators: TEXT_OPS,
    listable: true, searchable: true, icon: 'phone',
  },
  url: {
    storage: 'text', label: 'URL', group: 'Text', operators: TEXT_OPS,
    listable: true, icon: 'link',
  },
  password: {
    storage: 'text', label: 'Password', group: 'Text', operators: ['is_empty', 'is_not_empty'],
    icon: 'lock',
  },

  integer: {
    storage: 'number', label: 'Integer', group: 'Number', operators: NUM_OPS,
    listable: true, aggregatable: true, icon: 'hash',
  },
  decimal: {
    storage: 'number', label: 'Decimal', group: 'Number', operators: NUM_OPS,
    listable: true, aggregatable: true, icon: 'hash',
  },
  currency: {
    storage: 'number', label: 'Currency', group: 'Number', operators: NUM_OPS,
    listable: true, aggregatable: true, icon: 'indian-rupee',
  },
  percent: {
    storage: 'number', label: 'Percent', group: 'Number', operators: NUM_OPS,
    listable: true, aggregatable: true, icon: 'percent',
  },
  area: {
    storage: 'number', label: 'Area (sq.ft)', group: 'Number', operators: NUM_OPS,
    listable: true, aggregatable: true, icon: 'square',
  },

  picklist: {
    storage: 'text', label: 'Dropdown', group: 'Choice', operators: CHOICE_OPS,
    listable: true, searchable: true, aggregatable: true,
    requiresConfig: ['picklist'], icon: 'chevron-down',
  },
  multipicklist: {
    storage: 'json', label: 'Multi Select', group: 'Choice',
    operators: ['has_any', 'has_all', 'is_empty', 'is_not_empty'],
    listable: true, requiresConfig: ['picklist'], icon: 'list-checks',
  },
  boolean: {
    storage: 'boolean', label: 'Checkbox', group: 'Choice',
    operators: ['is_true', 'is_false'], listable: true, aggregatable: true, icon: 'check-square',
  },

  date: {
    storage: 'date', label: 'Date', group: 'Date & Time', operators: DATE_OPS,
    listable: true, aggregatable: true, icon: 'calendar',
  },
  datetime: {
    storage: 'datetime', label: 'Date & Time', group: 'Date & Time', operators: DATE_OPS,
    listable: true, aggregatable: true, icon: 'calendar-clock',
  },
  time: {
    storage: 'text', label: 'Time', group: 'Date & Time', operators: NUM_OPS,
    listable: true, icon: 'clock',
  },

  reference: {
    storage: 'uuid', label: 'Lookup (Relation)', group: 'Relationship',
    operators: ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty', 'contains'],
    listable: true, searchable: true, requiresConfig: ['referenceModules'], icon: 'link-2',
  },
  multireference: {
    storage: 'json', label: 'Multi Lookup', group: 'Relationship',
    operators: ['has_any', 'has_all', 'is_empty', 'is_not_empty'],
    requiresConfig: ['referenceModules'], icon: 'network',
  },
  owner: {
    storage: 'uuid', label: 'Owner (User/Team)', group: 'Relationship',
    operators: ['equals', 'not_equals', 'in', 'not_in', 'is_me', 'is_my_team'],
    listable: true, aggregatable: true, icon: 'user-check',
  },
  user: {
    storage: 'uuid', label: 'User', group: 'Relationship',
    operators: ['equals', 'not_equals', 'in', 'not_in', 'is_me', 'is_empty', 'is_not_empty'],
    listable: true, aggregatable: true, icon: 'user',
  },

  address: {
    storage: 'json', label: 'Address', group: 'Advanced',
    operators: ['contains', 'is_empty', 'is_not_empty'], searchable: true, icon: 'map-pin',
  },
  geolocation: {
    storage: 'json', label: 'Geo Location', group: 'Advanced',
    operators: ['is_empty', 'is_not_empty'], icon: 'map',
  },
  file: {
    storage: 'json', label: 'File Attachment', group: 'Advanced',
    operators: ['is_empty', 'is_not_empty'], icon: 'paperclip',
  },
  image: {
    storage: 'json', label: 'Image / Gallery', group: 'Advanced',
    operators: ['is_empty', 'is_not_empty'], icon: 'image',
  },
  tags: {
    storage: 'json', label: 'Tags', group: 'Advanced',
    operators: ['has_any', 'has_all', 'is_empty', 'is_not_empty'], listable: true, icon: 'tag',
  },
  json: {
    storage: 'json', label: 'JSON', group: 'Advanced',
    operators: ['is_empty', 'is_not_empty'], icon: 'braces',
  },

  autonumber: {
    storage: 'text', label: 'Auto Number', group: 'Computed', operators: TEXT_OPS,
    computed: true, listable: true, searchable: true,
    requiresConfig: ['numbering'], icon: 'binary',
  },
  formula: {
    storage: 'text', label: 'Formula', group: 'Computed', operators: TEXT_OPS,
    computed: true, listable: true, requiresConfig: ['formula'], icon: 'function-square',
  },
  rollup: {
    storage: 'number', label: 'Rollup Summary', group: 'Computed', operators: NUM_OPS,
    computed: true, listable: true, aggregatable: true,
    requiresConfig: ['rollup'], icon: 'sigma',
  },
  score: {
    storage: 'number', label: 'Score (0-100)', group: 'Computed', operators: NUM_OPS,
    listable: true, aggregatable: true, icon: 'gauge',
  },
};

export const UITYPE_LIST = Object.entries(UITYPES).map(([key, spec]) => ({
  uitype: key as UIType,
  ...spec,
}));

/** Config bag attached to a field; shape depends on uitype. */
export interface FieldConfig {
  /** picklist / multipicklist: name of the picklist to bind to. */
  picklist?: string;
  /** reference / multireference: modules the lookup can point at. */
  referenceModules?: string[];
  /** reference: restrict lookup to records matching this filter. */
  referenceFilter?: FilterGroup;
  /** autonumber: e.g. { prefix: 'LEAD-', digits: 5, start: 1, suffix: '' } */
  numbering?: { prefix?: string; suffix?: string; digits?: number; start?: number; resetPolicy?: 'never' | 'yearly' | 'monthly' };
  /** formula: safe expression, e.g. "{carpet_area} * {rate_per_sqft}" */
  formula?: { expression: string; returnType?: 'text' | 'number' | 'date' | 'boolean' };
  /** rollup: aggregate over a related module */
  rollup?: { relation: string; aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; filter?: FilterGroup };
  /** currency: ISO code, defaults to org currency */
  currency?: string;
  /** number formatting */
  decimals?: number;
  /** area unit */
  unit?: 'sqft' | 'sqm' | 'sqyd' | 'acre' | 'hectare';
  /** textarea rows / richtext toolbar */
  rows?: number;
  /** file/image constraints */
  accept?: string[];
  maxSizeMb?: number;
  multiple?: boolean;
  /** show a colour chip in lists (picklist) */
  colored?: boolean;
  /** field is part of the record's display label */
  partOfLabel?: boolean;
  /** UI hint: full width in the form grid */
  fullWidth?: boolean;
  /** conditional visibility inside forms */
  visibleWhen?: FilterGroup;
  /** placeholder text */
  placeholder?: string;
  /** integrations may mark fields as synced */
  externalKey?: string;

  // --- validation ----------------------------------------------------------
  // Declared here rather than coded into the engine, so a rule like "budget
  // from cannot exceed budget to" is metadata an admin can change, not an
  // `if (module === 'leads')` in recordService.

  /** numeric / currency / area: inclusive lower bound. */
  min?: number;
  /** numeric / currency / area: inclusive upper bound. */
  max?: number;
  /** text: a regular expression the value must match. */
  pattern?: string;
  /** The message shown when `pattern` fails — a regex is not an explanation. */
  patternMessage?: string;
  /** This value must be <= the named field's value ("budget from" ≤ "budget to"). */
  notAfterField?: string;
  /** This value must be >= the named field's value. */
  notBeforeField?: string;
  /** Exact number of digits, after stripping non-digits (an Indian mobile: 10). */
  digits?: number;
  /**
   * Name of the field that selects which digit count applies — for a mobile,
   * the country. Without this a flat "10 digits" rule makes the country
   * dropdown pointless, since a UAE number is 9 and a Singapore one is 8.
   */
  digitsFrom?: string;
  /** Digit count per value of `digitsFrom`; `digits` is the fallback. */
  digitsMap?: Record<string, number>;
  /**
   * Country codes offered inside the phone control itself.
   *
   * `digitsFrom` names the field the code is *stored* in; this is what the
   * dropdown attached to the number input lists. Carried on the phone field
   * rather than read from the other field's picklist so the control needs
   * nothing but its own metadata — it renders the same in a form, a list cell
   * and an inline edit, none of which have the sibling field to hand.
   */
  countryCodes?: { value: string; label: string }[];
  /**
   * The code shown in front of the number when there is no country field.
   *
   * One country is not a question. A business that only ever calls Indian
   * mobiles stores ten digits and paints `+91` on the box — no dropdown, no
   * second field to fill in, nothing to get wrong on an import. It is still a
   * setting rather than a constant, so a business that later sells in Dubai
   * changes one field instead of waiting for a deploy.
   */
  codePrefix?: string;
  /**
   * area: name of the field holding the unit, rendered as a dropdown beside
   * the number. `unit` stays the fallback for areas with a fixed unit.
   */
  unitField?: string;
  /** area: units the `unitField` dropdown offers. */
  unitOptions?: { value: string; label: string }[];

  [key: string]: unknown;
}

/** Field metadata as returned by the API and consumed by the dynamic renderer. */
export interface FieldMeta {
  id: string;
  moduleId: string;
  moduleName: string;
  blockId: string | null;
  name: string;
  label: string;
  uitype: UIType;
  /** Physical location: a real column, or a key inside the custom_fields JSONB. */
  storage: 'column' | 'json';
  columnName: string;
  sequence: number;
  isMandatory: boolean;
  isReadonly: boolean;
  isUnique: boolean;
  isCustom: boolean;
  isActive: boolean;
  /** hidden fields are stored but never rendered (system bookkeeping) */
  displayType: 'default' | 'readonly' | 'hidden' | 'detail_only' | 'create_only';
  defaultValue: unknown;
  maxLength: number | null;
  helpText: string | null;
  config: FieldConfig;
  quickCreate: boolean;
  massEditable: boolean;
  searchable: boolean;
  /** resolved at read time for picklist fields */
  options?: PicklistOption[];
}

export interface PicklistOption {
  value: string;
  label: string;
  color: string | null;
  sequence: number;
  isActive: boolean;
  isDefault?: boolean;
  /** picklist dependency: which values of the child picklist this unlocks */
  children?: Record<string, string[]>;
}

export interface BlockMeta {
  id: string;
  moduleId: string;
  name: string;
  label: string;
  sequence: number;
  isCollapsed: boolean;
  /** 1 = single column, 2 = two column form grid */
  columns: number;
  /** Blocks can be limited to certain profiles */
  visibleWhen?: FilterGroup;
  fields: FieldMeta[];
}

export interface ModuleMeta {
  id: string;
  name: string;
  label: string;
  singularLabel: string;
  tableName: string;
  icon: string;
  color: string;
  sequence: number;
  isEntity: boolean;
  isCustom: boolean;
  isActive: boolean;
  /** field name whose value forms the record's display label */
  labelFields: string[];
  /** module supports a kanban pipeline on this picklist field */
  pipelineField: string | null;
  /** duplicate-check field names */
  duplicateCheckFields: string[];
  supportsComments: boolean;
  supportsAttachments: boolean;
  supportsWorkflow: boolean;
  supportsTags: boolean;
  blocks: BlockMeta[];
  fields: FieldMeta[];
  relations: RelationMeta[];
}

export interface RelationMeta {
  id: string;
  name: string;
  label: string;
  sourceModule: string;
  targetModule: string;
  type: 'one_to_many' | 'many_to_many' | 'many_to_one';
  /** for one_to_many: the reference field on the target module */
  foreignField: string | null;
  sequence: number;
  /** actions available on the related list */
  actions: ('add' | 'select' | 'remove')[];
  /** columns shown in the related list; defaults to the target module's list view */
  columns?: string[];
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: unknown;
  /** for `between` */
  value2?: unknown;
  /** walk a reference field: "account_id.industry" is expressed as field with a dot */
  path?: string;
}

export interface FilterGroup {
  logic: 'AND' | 'OR';
  conditions: (FilterCondition | FilterGroup)[];
}

export function isFilterGroup(x: FilterCondition | FilterGroup): x is FilterGroup {
  return (x as FilterGroup).conditions !== undefined;
}

export const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] };

/** Operators that take no value input. */
export const NULLARY_OPERATORS: FilterOperator[] = [
  'is_empty', 'is_not_empty', 'is_true', 'is_false',
  'today', 'tomorrow', 'yesterday', 'this_week', 'this_month', 'this_quarter', 'this_year',
  'is_me', 'is_my_team',
];

export function operatorTakesValue(op: FilterOperator): boolean {
  return !NULLARY_OPERATORS.includes(op);
}

/**
 * How many digits a phone field should hold, given the rest of the record.
 *
 * Shared because both sides need the same answer and must not disagree: the
 * form caps typing at this length, and the server rejects anything else. Two
 * copies of this rule would eventually differ, and the symptom would be a
 * number a user cannot type but the API insists on.
 *
 * Returns 0 when no rule applies — an unmapped country is accepted rather than
 * measured against India's ten, because refusing to store a number we have no
 * rule for is worse than storing it.
 */
export function expectedDigits(
  config: FieldConfig | null | undefined,
  values: Record<string, unknown> | null | undefined,
): number {
  if (!config) return 0;
  if (!config.digits && !config.digitsMap) return 0;

  if (config.digitsFrom && config.digitsMap) {
    const selector = values?.[config.digitsFrom];
    if (selector === null || selector === undefined || selector === '') return config.digits ?? 0;
    return config.digitsMap[String(selector)] ?? 0;
  }
  return config.digits ?? 0;
}

// ---------------------------------------------------------------------------
// Field validation
//
// Lives in `shared` so the form and the API run the *same* code rather than two
// copies that drift. The server throws on the result; the form renders it under
// each input. A second implementation would eventually disagree, and the
// symptom is a value the user cannot type but the API insists on.
//
// Returns errors instead of throwing so the caller decides — and returns *all*
// of them, because a form that reports one problem per submit takes five round
// trips to fill in.
// ---------------------------------------------------------------------------

export interface FieldError { field: string; message: string }

/** Local blank test — `isEmpty` lives server-side and is not importable here. */
function isBlankValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

export function collectFieldErrors(
  fields: FieldMeta[],
  values: Record<string, unknown>,
  merged: Record<string, unknown>,
): FieldError[] {
  const errors: { field: string; message: string }[] = [];
  const fail = (field: string, message: string): void => { errors.push({ field, message }); };

  for (const f of fields) {
    if (!f.isActive || !(f.name in values)) continue;
    const value = values[f.name];
    // Empty is `validateRequired`'s business; an optional blank field is fine.
    if (isBlankValue(value)) continue;

    const config = f.config ?? {};

    if (typeof value === 'string') {
      if (f.maxLength && value.length > f.maxLength) {
        fail(f.name, `${f.label} cannot be longer than ${f.maxLength} characters`);
      }
      if (config.pattern) {
        try {
          if (!new RegExp(config.pattern).test(value)) {
            fail(f.name, config.patternMessage ?? `${f.label} is not in the expected format`);
          }
        } catch {
          // A malformed regex in metadata must not block every save on the
          // module — treat it as no rule and let the admin panel surface it.
        }
      }
      // The expected digit count can depend on another field — a mobile is 10
      // digits in India, 9 in the UAE, 8 in Singapore. Reading it from the
      // record keeps "10 digits" true where it is true without making the
      // country dropdown decorative.
      const expected = expectedDigits(config, merged);
      if (expected) {
        const digits = value.replace(/\D/g, '');
        if (digits.length !== expected) {
          fail(f.name, `${f.label} must be exactly ${expected} digits`);
        }
      }
    }

    switch (f.uitype) {
      case 'email':
        // Deliberately loose. Strict RFC 5322 rejects addresses that work, and
        // the only real test of an address is sending to it.
        if (typeof value === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
          fail(f.name, `${f.label} does not look like an email address`);
        }
        break;

      case 'url':
        if (typeof value === 'string' && !/^https?:\/\/[^\s]+$/i.test(value)) {
          fail(f.name, `${f.label} must start with http:// or https://`);
        }
        break;

      case 'phone': {
        const digits = String(value).replace(/\D/g, '');
        if (digits.length < 6 || digits.length > 15) {
          fail(f.name, `${f.label} does not look like a phone number`);
        }
        break;
      }

      case 'integer':
      case 'decimal':
      case 'currency':
      case 'percent':
      case 'area':
      case 'score': {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          fail(f.name, `${f.label} must be a number`);
          break;
        }
        if (config.min !== undefined && n < config.min) {
          fail(f.name, `${f.label} cannot be less than ${config.min}`);
        }
        if (config.max !== undefined && n > config.max) {
          fail(f.name, `${f.label} cannot be more than ${config.max}`);
        }
        break;
      }
    }

    // Cross-field bounds. Compared against `merged` — the stored record plus
    // this payload — so editing only "budget from" still checks against the
    // "budget to" already on the record rather than skipping the rule.
    for (const [key, compare] of [['notAfterField', 1], ['notBeforeField', -1]] as const) {
      const otherName = config[key];
      if (typeof otherName !== 'string') continue;
      const other = merged[otherName];
      if (isBlankValue(other)) continue;

      const a = Number(value);
      const b = Number(other);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

      const otherLabel = fields.find((x) => x.name === otherName)?.label ?? otherName;
      if (compare === 1 && a > b) fail(f.name, `${f.label} cannot be more than ${otherLabel}`);
      if (compare === -1 && a < b) fail(f.name, `${f.label} cannot be less than ${otherLabel}`);
    }
  }

  return errors;
}
