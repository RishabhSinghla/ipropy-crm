/**
 * Is this stored value a phone number somebody could actually ring on a mobile?
 *
 * Pure, and in its own file so a test can reach it — the audit script it was
 * written for opens a database connection as it loads, so anything left inside
 * it could only be checked by running it against real data, which is exactly
 * the thing that must not be trusted unchecked.
 *
 * The rule is the owner's, stated on 19 September 2026: a proper Indian mobile
 * is **ten digits starting 6, 7, 8 or 9**.
 */
/**
 * Strip the country code, and only the country code.
 *
 * `country_code` is its own field (migration 026), so `mobile` is meant to hold
 * national digits alone. Imported rows do not all obey that — the Vtiger import
 * and some lead sources wrote full E.164 — so a leading +91 or 91 comes off
 * before the rest is judged. Without this, thousands of perfectly reachable
 * people would be reported as "too long" purely for carrying their own country
 * code, which is the wrong answer in the expensive direction.
 *
 * A leading **0** is deliberately NOT stripped here. In Indian dialling that 0
 * is the STD trunk prefix, and dropping it turns an 080 Bangalore landline into
 * a ten-digit number starting 8 — indistinguishable from a mobile. `classify`
 * deals with it, and refuses to guess where it genuinely cannot tell.
 */
export function national(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  return digits;
}

/** All one digit, or a straight run up or down through the whole number. */
function isPattern(n) {
  if (n.length < 8) return false;
  if (/^(\d)\1+$/.test(n)) return true;
  return '01234567890'.includes(n) || '09876543210'.includes(n);
}

/**
 * Which bucket a stored value falls in.
 *
 * Order matters. `obvious_junk` is tested *before* `mobile` on purpose:
 * 9999999999 satisfies the owner's rule exactly — ten digits, starts with a 9 —
 * and is still somebody typing whatever got past a mandatory field. Reporting
 * it as a good mobile would be technically right and useless. 9876543210 is
 * here for the same reason and is the one judgement call in this file: it is a
 * well-formed number in a live series, and in Indian data it is overwhelmingly
 * the placeholder somebody typed. It is counted separately so that call can be
 * overturned by reading the number rather than by trusting this comment.
 */
export function classify(raw) {
  const text = String(raw).trim();
  if (!text) return 'blank';

  const digits = text.replace(/\D/g, '');
  if (!digits) return 'no_digits';

  const n = national(text);
  if (isPattern(n)) return 'obvious_junk';

  /*
    Eleven digits starting 0. The 0 is the STD prefix, so what follows is an
    area code — except that Bangalore is 080 and Ahmedabad is 079, and once the
    0 comes off those read as a mobile starting 8 or 7. Where the remainder
    starts 1-5 no mobile series can claim it and it is a landline outright.
    Where it starts 6-9 the number is genuinely ambiguous, and it gets its own
    bucket rather than a guess: somebody has to look.
  */
  if (n.length === 11 && n.startsWith('0')) {
    const rest = n.slice(1);
    if (isPattern(rest)) return 'obvious_junk';
    return /^[1-5]/.test(rest) ? 'landline' : 'leading_zero';
  }

  if (n.length === 10 && /^[6-9]/.test(n)) return 'mobile';

  // A ten-digit number whose first digit no mobile series uses, or a local
  // number stored without its area code. Real numbers; not mobiles.
  if (n.length === 10 && /^[1-5]/.test(n)) return 'landline';
  if (n.length === 11 || n.length === 9 || n.length === 8) return 'landline';

  if (n.length < 8) return 'too_short';
  return 'too_long';
}

export const LABELS = {
  mobile: 'A proper mobile (10 digits, starts 6/7/8/9)',
  landline: 'Looks like a landline (wrong length, or starts 1-5)',
  leading_zero: 'Has a 0 in front — could be either, needs a look',
  obvious_junk: 'Obvious junk (9999999999, 1234567890 and the like)',
  too_short: 'Too short to be any phone number',
  too_long: 'Too long to be any phone number',
  no_digits: 'No digits in it at all',
  blank: 'Empty',
};
export const BAD = ['landline', 'leading_zero', 'obvious_junk', 'too_short', 'too_long', 'no_digits'];

/** Hide the last four digits. Enough to see the shape, not enough to ring. */
export const mask = (v) => {
  const s = String(v).trim();
  return s.length <= 4 ? 'x'.repeat(s.length) : s.slice(0, -4) + 'xxxx';
};

