/**
 * Turning what somebody said into what a field stores.
 *
 * Deliberately pure and dependency-free, so it can be tested exhaustively
 * without a database, a network or a model. That matters more here than
 * anywhere else in the capture path: this is the last thing standing between a
 * misheard sentence and a property listed at the wrong price.
 *
 * The division of labour is the point. A language model is good at hearing
 * "three point two five crore" in a Hindi-English sentence and writing it as
 * "3.25 cr". It is not something to trust with the arithmetic that turns that
 * into 32500000, or with deciding whether "east" is a valid option for a
 * picklist. Those happen here, deterministically.
 */
import { parseIndianPrice, type FieldMeta } from '@ipropy/shared';

/**
 * Coerce a spoken value to the field's stored type.
 *
 * Returns `undefined` for anything that does not convert cleanly, and callers
 * drop it. Half-understood values are worse than absent ones: they make a
 * review screen something people skim instead of read, which defeats the point
 * of having one.
 */
export function coerceSpokenValue(field: FieldMeta, spoken: string, options: string[] = []): unknown {
  const text = String(spoken ?? '').trim();
  if (!text) return undefined;

  switch (field.uitype) {
    case 'currency': {
      // parseIndianPrice rather than Number: "3.25 cr" is the entire point, and
      // Number("3.25 cr") is NaN.
      const n = parseIndianPrice(text);
      return n !== null && n > 0 ? n : undefined;
    }

    case 'area':
    case 'decimal':
    case 'percent': {
      const n = firstNumber(text);
      return n === null ? undefined : n;
    }

    case 'integer':
    case 'score': {
      const n = firstNumber(text);
      return n === null ? undefined : Math.round(n);
    }

    case 'boolean': {
      // Hindi yes/no included: "lift hai" comes back as "haan" often enough.
      if (/^(yes|y|true|available|present|haan|han|ha)$/i.test(text)) return true;
      if (/^(no|n|false|none|absent|nahi|nahin)$/i.test(text)) return false;
      return undefined;
    }

    case 'picklist':
    case 'multipicklist': {
      const match = matchOption(text, options);
      if (!match) return undefined;
      return field.uitype === 'multipicklist' ? [match] : match;
    }

    case 'phone': {
      // Indian mobiles are ten digits; a spoken number arrives with spaces, and
      // sometimes with a country code in front of it.
      const digits = text.replace(/\D/g, '');
      return digits.length >= 10 ? digits.slice(-10) : undefined;
    }

    case 'email': {
      // Dictated addresses are almost always wrong ("at the rate", missing
      // dots), and a wrong address fails silently at send time. Better absent.
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text.toLowerCase() : undefined;
    }

    case 'date':
    case 'datetime': {
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }

    default:
      return text.slice(0, 500);
  }
}

/**
 * The first number in a phrase.
 *
 * Speech carries its unit along — "325 gaj", "2400 sq ft", "2nd floor" — and
 * the unit belongs to the field, not the value. Stripping every non-digit
 * instead would turn "2400 sq ft" into 2400 by luck and "3 BHK 2 bath" into
 * 32 by accident.
 */
function firstNumber(text: string): number | null {
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Match spoken text against a picklist's options.
 *
 * Only ever returns an option that exists. A picklist that quietly accepts
 * freehand text stops grouping, filtering and reporting — the three reasons it
 * is a picklist rather than a text box.
 *
 * Progressively looser, stopping at the first hit: exact, then ignoring case
 * and spacing ("4bhk" → "4 BHK"), then ignoring punctuation ("2-BHK"), then a
 * whole-word containment so "east facing" finds "East".
 */
export function matchOption(text: string, options: string[]): string | null {
  const norm = (s: string): string => s.toLowerCase().trim();
  const tight = (s: string): string => norm(s).replace(/[\s._-]+/g, '');

  return options.find((o) => norm(o) === norm(text))
    ?? options.find((o) => tight(o) === tight(text))
    ?? options.find((o) => {
      // Word-boundary containment only. Without it "no parking" matches "Parking"
      // and a property gains an amenity the speaker just denied having.
      const pattern = new RegExp(`\\b${escapeRegex(norm(o))}\\b`);
      return pattern.test(norm(text));
    })
    ?? null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
