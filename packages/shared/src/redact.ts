/**
 * Removing a way to contact somebody from a string.
 *
 * Shared, because it was written twice — once for the server's error reports and
 * once for the browser's — and the two immediately drifted. Twelve phone formats
 * were fixed on the server and stayed broken in the browser, which is the worse
 * half: a crash in the browser carries whatever was on screen, and what is on
 * screen in a CRM is a person.
 *
 * The rule this enforces: an error report may say **what** broke and **where**,
 * and never **who for**.
 *
 * It is a filter, not a proof, and the boundary is deliberate — see the tests.
 * The guarantee that actually holds sits further back: no request body is
 * attached, the query string is dropped whole, and the user is cut to an id.
 */

/**
 * Email, in the shapes people actually write them.
 *
 * Deliberately loose on the local part: an apostrophe in `o'brien@` and a plus
 * in `buyer+site@` are both real, and a filter that misses one is a leak while
 * a filter that catches a bit extra costs nothing.
 */
const EMAIL = /[^\s<>()[\]{},;:"]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * A candidate phone number: a run of digits long enough to be one, however it
 * has been punctuated.
 *
 * Chasing separator arrangements with one pattern was the original approach and
 * it leaked twelve ways — a dot, a slash, an en dash, an underscore, a comma,
 * double spaces, `9811 533 633`, `981 153 3633`, and every Faridabad landline.
 * Those are not exotic; they are how numbers arrive from imports and from people
 * typing. So this finds anything that *might* be a number and `isPhone` below
 * decides, which is a far smaller thing to get right.
 */
const DIGIT_RUN = /[+(]?[\d\u0966-\u096F][\d\u0966-\u096F\s.\-/_,()|*:–—]{7,}[\d\u0966-\u096F]/g;

/** Devanagari ०-९ are digits too, and this CRM is used in Hindi. */
function toAsciiDigits(text: string): string {
  return text.replace(/[\u0966-\u096F]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

/**
 * Characters that are not there.
 *
 * A zero-width space between the halves of a phone number defeated the whole
 * filter, and it is invisible — it survives a copy and paste out of a browser or
 * a PDF and nobody can see it in the note afterwards. Removed before anything is
 * scanned, because a character with no width should never change what a pattern
 * matches.
 */
const INVISIBLE = /[\u200B-\u200D\uFEFF\u2060\u00AD]/g;

/**
 * Whether a run of digits is a way to reach somebody in India.
 *
 * Over-matching here is cheap — a redacted order number costs a little
 * debugging context. Under-matching publishes a customer's number to a company
 * in another country, so every uncertain case resolves towards redacting.
 */
function isPhone(raw: string): boolean {
  const digits = toAsciiDigits(raw).replace(/\D/g, '');

  // Mobile, with or without 0 / 91 / 0091 in front.
  const national = digits.replace(/^(?:0091|091|91|0)/, '');
  if (/^[6-9]\d{9}$/.test(national)) return true;

  // Landline: an STD code of two to four digits and a six to eight digit
  // number, which is what 0129 2419711 in Faridabad looks like.
  if (/^0\d{9,10}$/.test(digits)) return true;
  if (/^(?:91)?\d{10,11}$/.test(digits) && digits.length <= 12) return true;

  return false;
}

/** Replace every phone-shaped run, leaving everything else alone. */
function redactPhones(text: string): string {
  return text.replace(DIGIT_RUN, (match) => {
    // Keep any trailing punctuation the greedy match swallowed.
    const trimmed = match.replace(/[\s.,;:)\]]+$/, '');
    const tail = match.slice(trimmed.length);
    return isPhone(trimmed) ? `[redacted]${tail}` : match;
  });
}


/** Everything above, applied. */
export function redactContactDetails(text: string): string {
  /*
    `%40` is decoded before scanning because that is what a browser writes for an
    `@` inside a URL — so the normal form of an email in a logged URL, a fetch
    error or a referer header hid from the pattern completely. Decoding is
    per-token and failure-tolerant: a stray `%` is common in real text and must
    not throw.
  */
  const decoded = text.includes('%')
    ? text.replace(/%40/gi, '@').replace(/%2E/gi, '.')
    : text;

  return redactPhones(decoded.replace(INVISIBLE, '').replace(EMAIL, '[redacted]'));
}

export const __redactTesting = { isPhone, redactPhones, toAsciiDigits };
