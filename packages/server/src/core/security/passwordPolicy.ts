/**
 * What a new password has to be, in one place.
 *
 * 11 October 2026, security review. The rule used to be "at least 8
 * characters" on the server and "upper, lower and a number" only in the
 * browser's own hint — so anything that spoke to the API directly, or a screen
 * that forgot to check, could set `password`. Four routes chose passwords and
 * each carried its own copy of `min(8)`.
 *
 * Length does most of the work; the blocklist stops the choices that are
 * guessed first, including the one published in this repository. Existing
 * passwords are not touched — this governs only a password being set now.
 */
import { z } from 'zod';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** Said to people on every screen that sets a password. */
export const PASSWORD_RULE = `At least ${PASSWORD_MIN} characters, with an upper case letter, a lower case letter and a number.`;

/**
 * Compared in lower case with spaces and punctuation removed, so
 * `Admin@123` and `admin 123` are the same guess.
 */
const GUESSED_FIRST = new Set([
  'admin123', 'admin1234', 'admin12345', 'administrator', 'password', 'password1', 'password12', 'password123',
  'password1234', 'passw0rd', 'pass1234', 'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty12345', '1q2w3e4r',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910', '0987654321', '111111', '000000',
  'iloveyou', 'welcome', 'welcome1', 'welcome123', 'letmein', 'letmein123', 'monkey', 'dragon', 'abc123',
  'abcd1234', 'abcdefgh', 'changeme', 'changeme123', 'default', 'test1234', 'testing123', 'sunshine',
  'ipropy', 'ipropy123', 'ipropy1234', 'ipropycrm', 'ipropy2026', 'crm12345', 'crm123456', 'india123',
  'india1234', 'delhi123', 'mumbai123', 'noida123', 'gurgaon123', 'faridabad123', 'realestate', 'realestate1',
  'property123', 'sales1234', 'agent1234', 'broker123', 'jaishreeram', 'omnamahshivay', 'god12345', 'krishna123',
]);

function squashed(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Why this password is not allowed, in words a person can act on — or null when it is fine. */
export function whyPasswordIsWeak(password: string, email?: string | null): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'Use an upper case letter, a lower case letter and a number.';
  }
  const flat = squashed(password);
  if (GUESSED_FIRST.has(flat)) return 'That password is one of the first things anybody tries. Pick something else.';
  if (new Set(flat).size < 5) return 'Mix in more different characters.';
  if (email) {
    const name = squashed(email.split('@')[0] ?? '');
    if (name.length >= 4 && flat.includes(name)) return 'Do not put your e-mail address in your password.';
  }
  return null;
}

/** For a request body: `password: strongPassword`. */
export const strongPassword = z.string().superRefine((value, ctx) => {
  const problem = whyPasswordIsWeak(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
