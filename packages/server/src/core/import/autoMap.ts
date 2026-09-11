/**
 * Guessing which CRM field a spreadsheet column means.
 *
 * The old rule was "the header, stripped of punctuation, equals the field name
 * or its label". On a real file — `Customer Name`, `Mobile No`, `Requirement`,
 * `Unit` — that maps three columns out of eight and leaves somebody to do the
 * rest by hand, which is the moment an import stops feeling like something the
 * CRM did for you.
 *
 * Three signals, in the order they deserve to be trusted:
 *
 *  1. The header *is* the field, by name or label, once punctuation is gone.
 *  2. The header is a phrase this trade uses for that field — `Demand`,
 *     `Asking Price` and `Budget` are one column under three names.
 *  3. The sample values look like the field's type — ten digits is a phone,
 *     `1.75 Cr` is money — which is only ever used to *choose between*
 *     candidates or to confirm one, never to invent a match on its own.
 *
 * A guess is only committed when it is certain. Anything less is offered and
 * left for a person to accept, because a silently mis-mapped column writes
 * mobile numbers into a budget field and nobody finds out until a report is
 * wrong.
 */
import type { FieldMeta } from '@ipropy/shared';

export type Confidence = 'certain' | 'likely' | 'possible';

export interface Suggestion {
  header: string;
  field: string;
  confidence: Confidence;
  /** Shown to the admin so the guess can be judged rather than trusted. */
  reason: string;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Words that mean the same column in this trade.
 *
 * Keyed by the concept, not by a field name, because the field it lands on
 * depends on the module: `demand` is a property's asking price and a contact's
 * budget, and both are the money column on their own module.
 */
const SYNONYMS: { concept: string; words: string[]; uitypes: string[] }[] = [
  { concept: 'phone', uitypes: ['phone'],
    words: ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'phonenumber', 'contactno',
      'contactnumber', 'cell', 'cellno', 'whatsapp', 'whatsappno', 'whatsappnumber', 'primarymobile'] },
  { concept: 'name', uitypes: ['string'],
    words: ['name', 'fullname', 'customername', 'clientname', 'contactname', 'partyname',
      'ownername', 'leadname', 'buyername'] },
  { concept: 'email', uitypes: ['email'],
    words: ['email', 'emailid', 'emailaddress', 'mailid', 'mail'] },
  { concept: 'money', uitypes: ['currency'],
    words: ['budget', 'price', 'demand', 'askingprice', 'asking', 'rate', 'amount', 'cost',
      'expectedprice', 'propertyprice', 'propertydemand', 'value'] },
  { concept: 'area', uitypes: ['area', 'decimal', 'integer'],
    words: ['area', 'size', 'plotsize', 'plotarea', 'carpetarea', 'builtuparea', 'superarea',
      'sqft', 'sqyd', 'squarefeet', 'squareyards', 'requiredarea'] },
  { concept: 'unit', uitypes: ['picklist'],
    words: ['unit', 'areaunit', 'sizeunit', 'measurement', 'uom'] },
  { concept: 'config', uitypes: ['picklist', 'multipicklist'],
    // Deliberately not `type`: it is the label of Contact Type as much as of
    // unit type, and a synonym that matches two fields is worse than none —
    // it turns a certain guess into a coin toss.
    words: ['bhk', 'configuration', 'requirement', 'bedrooms', 'bedroom', 'propertyconfiguration'] },
  { concept: 'status', uitypes: ['picklist'],
    words: ['status', 'stage', 'leadstatus', 'propertystatus', 'availability', 'pipelinestatus'] },
  { concept: 'source', uitypes: ['picklist'],
    words: ['source', 'leadsource', 'campaign', 'channel', 'referredby', 'via'] },
  { concept: 'location', uitypes: ['picklist', 'multipicklist', 'string'],
    words: ['location', 'locality', 'area2', 'sector', 'preferredlocation', 'preferredlocations',
      'city', 'region', 'address'] },
  { concept: 'followup', uitypes: ['date', 'datetime'],
    words: ['followup', 'nextfollowup', 'followupdate', 'nextcall', 'callback', 'duedate'] },
  { concept: 'owner', uitypes: ['owner', 'user'],
    words: ['assignedto', 'owner', 'agent', 'salesperson', 'rm', 'relationshipmanager', 'handledby'] },
];

/** What the values in a column look like, used only to break a tie. */
function looksLike(samples: unknown[]): Set<string> {
  const out = new Set<string>();
  const seen = samples.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 20);
  if (!seen.length) return out;
  const all = (test: (v: string) => boolean): boolean => seen.every(test);

  if (all((v) => /^[+\d][\d\s()-]{7,}$/.test(v) && v.replace(/\D/g, '').length >= 10)) out.add('phone');
  if (all((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) out.add('email');
  if (all((v) => /(cr|crore|lac|lakh)\b/i.test(v) || /^[₹\s]*[\d,]+(\.\d+)?$/.test(v))) out.add('currency');
  if (all((v) => /^\d{1,4}[-/.]\d{1,4}[-/.]\d{2,4}$/.test(v))) out.add('date');
  if (all((v) => /^[\d,]+(\.\d+)?$/.test(v))) out.add('number');
  return out;
}

const TYPE_FAMILY: Record<string, string> = {
  phone: 'phone', email: 'email', currency: 'currency',
  date: 'date', datetime: 'date',
  integer: 'number', decimal: 'number', area: 'number', percent: 'number',
};

export function suggestMapping(
  fields: FieldMeta[],
  headers: string[],
  rows: Record<string, unknown>[] = [],
): Suggestion[] {
  /*
    A unit companion is hidden and still importable.

    `area_unit` and `budget_unit` are `display_type: hidden` because the form
    shows one combined control, not two boxes — but a spreadsheet keeps the
    amount and the unit in separate columns, and refusing the unit as a target
    means the importer maps a column headed `Unit` onto whatever else it can
    find. It picked `contact_type`.
  */
  const usable = fields.filter((f) =>
    f.isActive && !f.isReadonly && f.config.importable !== false
    && (f.displayType !== 'hidden' || Boolean(f.config.unitMaster)));

  const byExact = new Map<string, FieldMeta>();
  for (const f of usable) {
    byExact.set(squash(f.name), f);
    if (!byExact.has(squash(f.label))) byExact.set(squash(f.label), f);
  }

  const out: Suggestion[] = [];
  const taken = new Set<string>();
  const settled = new Set<string>();

  /*
    Every column named after a field is settled before any guessing starts.

    Walking the headers once, in order, let a guess claim a field that a later
    column matched outright: on a property sheet, `Unit` reached `status`
    through a synonym and the column actually headed `Status` was left with
    `facing`. Nothing a person types in the heading row is a stronger signal
    than the field's own name.
  */
  for (const header of headers) {
    const exact = byExact.get(squash(header));
    if (!exact || taken.has(exact.name)) continue;
    taken.add(exact.name);
    settled.add(header);
    out.push({ header, field: exact.name, confidence: 'certain', reason: 'the column is named after this field' });
  }

  for (const header of headers) {
    const key = squash(header);
    if (!key || settled.has(header)) continue;
    const shape = looksLike(rows.map((r) => r[header]));

    // The header is a phrase for it.
    const concept = SYNONYMS.find((c) => c.words.includes(key));
    /*
      Named first, typed second.

      Taking the first field of the right type picked `contact_type` for a
      column headed `Unit` and `lead_source` for one headed `Status` — the
      right *kind* of field and the wrong field, which is the worst sort of
      wrong here because it looks deliberate. A field whose own name or label
      is one of the concept's words is the field being talked about; the type
      is only a tie-break after that.
    */
    const named = concept
      ? usable.filter((f) => !taken.has(f.name)
        && (concept.words.includes(squash(f.name)) || concept.words.includes(squash(f.label))))
      : [];
    const typed = concept
      ? usable.filter((f) => !taken.has(f.name) && concept.uitypes.includes(f.uitype))
      : [];
    const candidates = named.length ? named : typed;

    if (candidates.length) {
      // A shape that agrees promotes the guess; several candidates of the same
      // type is exactly when a person should choose.
      const agrees = candidates.filter((f) => shape.has(TYPE_FAMILY[f.uitype] ?? ''));
      const pick = agrees[0] ?? candidates[0]!;
      const confidence: Confidence = named.length === 1
        ? 'certain'
        : candidates.length === 1
          ? (agrees.length ? 'certain' : 'likely')
          : (agrees.length === 1 ? 'likely' : 'possible');
      taken.add(pick.name);
      out.push({
        header, field: pick.name, confidence,
        reason: agrees.length
          ? `“${header}” usually means this, and the values look like it`
          : `“${header}” usually means this`,
      });
      continue;
    }

    // 3. Nothing but the shape, which is never enough on its own — a column of
    //    ten-digit numbers could be a mobile or an alternate mobile.
    const family = [...shape][0];
    const onlyByShape = family
      ? usable.filter((f) => !taken.has(f.name) && TYPE_FAMILY[f.uitype] === family)
      : [];
    if (onlyByShape.length === 1) {
      taken.add(onlyByShape[0]!.name);
      out.push({
        header, field: onlyByShape[0]!.name, confidence: 'possible',
        reason: `the only ${family} field on this module, and the values look like one`,
      });
    }
  }

  return out;
}

/** Only what is safe to fill in for somebody. */
export function certainMapping(suggestions: Suggestion[]): Record<string, string> {
  return Object.fromEntries(
    suggestions.filter((s) => s.confidence === 'certain' || s.confidence === 'likely')
      .map((s) => [s.header, s.field]),
  );
}
