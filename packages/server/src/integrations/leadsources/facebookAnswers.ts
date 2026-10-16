/**
 * Files a Facebook form's answers into the matching contact fields.
 *
 * Every form asks its own questions, and Facebook names each answer after the
 * question's wording ("what_is_your_preferred_budget_range?"). A list of exact
 * names breaks the day somebody rewords a question — on 16 October 2026 a new
 * form's budget and timeline arrived and were left in the notes, because the
 * code was waiting for the old form's spelling.
 *
 * So this reads what a question is *asking* (budget, when, which area…) and
 * what each field is *called*, and files the answer only when it is valid for
 * that field. An answer that fits nothing is left alone: it stays in the
 * enquiry note, and the lead is never refused over a mapping.
 */
import type { FieldMeta, PicklistOption } from '@ipropy/shared';
import { parseBudget } from './parseBudget.js';

export interface FacebookAnswer { name: string; values?: string[] }

/** Questions the capture path already reads by name. */
const QUESTIONS_ALREADY_READ = new Set([
  'full_name', 'name', 'first_name', 'last_name', 'email', 'phone_number', 'phone',
]);

/** What the CRM decides, never what a customer's answer may set. */
const NEVER_FROM_AN_ANSWER = new Set([
  'full_name', 'email', 'mobile', 'country_code', 'whatsapp_number', 'owner_id',
  'status', 'lost_reason', 'lead_source', 'source', 'sub_source', 'description', 'lifecycle_stage',
]);

/** The questions every real-estate form asks, and the field each one fills. */
const COMMON_QUESTIONS: { field: string; asks: RegExp }[] = [
  { field: 'budget', asks: /budget|afford|price range/ },
  { field: 'possession_timeline', asks: /when .*(buy|purchase|plan|book|move)|timeline|how soon|planning to (buy|purchase)/ },
  { field: 'preferred_locations', asks: /which (location|area|locality|sector)|preferred (location|area|locality)/ },
  { field: 'configuration', asks: /bhk|bedroom|configuration/ },
  { field: 'purpose', asks: /purpose|invest|self.?use|end.?use/ },
  { field: 'interested_project', asks: /which (project|property)|project name/ },
];

const FILLABLE = new Set([
  'string', 'textarea', 'integer', 'decimal', 'currency', 'area', 'picklist', 'radio', 'multipicklist',
]);
const NUMBER_TYPES = new Set(['integer', 'decimal', 'currency', 'area']);
const FILLER_WORDS = new Set(['what', 'is', 'are', 'your', 'you', 'do', 'the', 'a', 'an', 'of', 'to', 'in', 'for', 'which', 'how', 'would', 'like']);

/** "what_is_your_budget?" → "what is your budget" */
export function readQuestion(key: string): string {
  return key.replace(/_/g, ' ').replace(/[?]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The same word in different clothes: "looking" and "exploring" are one answer. */
function plainAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/(\d)\s*(?:to|-|–)\s*(\d)/g, '$1-$2')
    .replace(/\blooking\b/g, 'exploring')
    .replace(/\b(asap|immediately|right now)\b/g, 'immediate')
    .replace(/[^a-z0-9\-. ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The dropdown option an answer means, or nothing when none of them fits. */
export function matchOption(answer: string, options: PicklistOption[] | undefined): PicklistOption | undefined {
  const wanted = plainAnswer(answer);
  if (!wanted) return undefined;
  const live = (options ?? []).filter((o) => o.isActive !== false);
  const named = (o: PicklistOption): string[] => [o.value, o.label].map(plainAnswer);
  return live.find((o) => named(o).includes(wanted))
    ?? live.find((o) => named(o).some((n) => n.length >= 4 && (n.includes(wanted) || wanted.includes(n))));
}

function wordsOf(text: string): string[] {
  return readQuestion(text).split(' ')
    .map((word) => word.replace(/s$/, ''))
    .filter((word) => word && !FILLER_WORDS.has(word));
}

/** A field whose whole label is spoken in the question: "Occupation" in "what is your occupation?". */
function fieldNamedInQuestion(question: string, fields: FieldMeta[]): FieldMeta | undefined {
  const spoken = new Set(wordsOf(question));
  return fields
    .filter((f) => f.isActive && FILLABLE.has(f.uitype) && f.displayType !== 'readonly' && f.displayType !== 'hidden')
    .filter((f) => !NEVER_FROM_AN_ANSWER.has(f.name))
    .map((f) => ({ field: f, label: wordsOf(f.label) }))
    .filter(({ label }) => label.length > 0 && label.every((word) => spoken.has(word)))
    .sort((a, b) => b.label.length - a.label.length)[0]?.field;
}

function fieldForQuestion(question: string, fields: FieldMeta[]): FieldMeta | undefined {
  const common = COMMON_QUESTIONS.find((q) => q.asks.test(question));
  const byTopic = common ? fields.find((f) => f.name === common.field && f.isActive) : undefined;
  return byTopic ?? fieldNamedInQuestion(question, fields);
}

/** The value in the shape the field stores, or undefined when the answer does not fit it. */
function valueFor(field: FieldMeta, answer: string): unknown {
  if (NUMBER_TYPES.has(field.uitype)) {
    return field.name === 'budget' || field.uitype === 'currency'
      ? parseBudget(answer)
      : Number.isFinite(Number(answer)) ? Number(answer) : undefined;
  }
  if (field.uitype === 'picklist' || field.uitype === 'radio') return matchOption(answer, field.options)?.value;
  if (field.uitype === 'multipicklist') {
    const option = matchOption(answer, field.options);
    return option ? [option.value] : undefined;
  }
  return answer;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * Field values to add to a new contact. A field already filled is left alone, so
 * the first question to claim a field keeps it.
 */
export function mapFacebookAnswers(
  fieldData: FacebookAnswer[] | undefined,
  fields: FieldMeta[],
  alreadyFilled: Record<string, unknown>,
): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  for (const answer of fieldData ?? []) {
    if (QUESTIONS_ALREADY_READ.has(answer.name.toLowerCase())) continue;
    const text = (answer.values?.[0] ?? '').replace(/_/g, ' ').trim();
    if (!text) continue;
    const field = fieldForQuestion(readQuestion(answer.name), fields);
    if (!field || !isEmpty(alreadyFilled[field.name]) || !isEmpty(filled[field.name])) continue;
    const value = valueFor(field, text);
    if (!isEmpty(value)) filled[field.name] = value;
  }
  return filled;
}
