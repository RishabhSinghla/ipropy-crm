/**
 * T9: finding a contact by typing their name on a number pad.
 *
 * **3 October 2026, the owner's dialler prototype** — the keypad screen shows
 * *"T9 MATCH (2)"* above the number, and two contacts under it. A rep typing
 * `726` means "PAM…", "RAN…", "SAN…" — the same three keys spell all of them,
 * which is the whole point: one thumb, no keyboard, no switching screens.
 *
 * It lives here rather than in the screen for the reason this repo keeps
 * re-learning: a `node` test can read this file, and cannot read a component
 * that imports the app's store.
 *
 * **It matches a name OR a number, and never pretends the two are the same.**
 * Typing `98102` is a person looking for a phone number; typing `726` is a
 * person looking for a name. Both are offered, with the number matches first,
 * because somebody halfway through dialling has already decided.
 */

/** The letters on each key, as every phone has had them since 1963. */
const KEYS: Record<string, string> = {
  '2': 'abc',
  '3': 'def',
  '4': 'ghi',
  '5': 'jkl',
  '6': 'mno',
  '7': 'pqrs',
  '8': 'tuv',
  '9': 'wxyz',
};

/** Which key a letter sits on — built once from the table above. */
const KEY_OF = new Map<string, string>();
for (const [digit, letters] of Object.entries(KEYS)) {
  for (const letter of letters) KEY_OF.set(letter, digit);
}

/**
 * A name as the digits somebody would press to spell it.
 *
 * Anything that is not a letter — a space, a hyphen, a full stop, a Devanagari
 * character — is dropped rather than mapped. A space is not a key, and treating
 * one as a digit would mean "Ravi Kumar" could never be found by typing the
 * start of "Kumar".
 */
export function digitsForName(name: string): string {
  let out = '';
  for (const character of name.toLowerCase()) {
    const key = KEY_OF.get(character);
    if (key) out += key;
  }
  return out;
}

/**
 * The digits of a phone number, with everything a person might type around
 * them taken off: `+91 98102-34567` and `09810234567` are the same number.
 */
export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * Does this name begin with these keys — as a whole, or at any word in it?
 *
 * "Pradeep Gupta" answers to `772` (Pradeep) and to `4878` (Gupta), because a
 * rep looking for somebody thinks of either name and should not have to
 * remember which one the CRM filed them under.
 */
export function nameMatchesKeys(name: string, keys: string): boolean {
  if (!keys) return false;
  const words = name.split(/\s+/).filter(Boolean);
  for (const word of [name, ...words]) {
    if (digitsForName(word).startsWith(keys)) return true;
  }
  return false;
}

/**
 * Does this number contain what has been typed?
 *
 * `includes`, not `startsWith`: a rep who remembers the last four digits is
 * doing the thing a dialler is for, and a stored `+91…` prefix would otherwise
 * make every number fail a leading-digit test.
 */
export function numberMatchesTyped(stored: string, typed: string): boolean {
  const want = digitsOnly(typed);
  if (!want) return false;
  return digitsOnly(stored).includes(want);
}

export interface Dialable {
  id: string;
  name: string;
  /** Every number this record holds — mobile, alternate, whatever an admin added. */
  numbers: string[];
}

export interface T9Hit<T extends Dialable> {
  record: T;
  /** `number` beat `name`, which is what decides the order. */
  how: 'number' | 'name';
}

/**
 * The contacts worth offering for what has been typed so far.
 *
 * **Number matches come first.** Somebody who has typed seven digits is
 * dialling; somebody who has typed three is probably spelling. Ordering the
 * other way round buries the obvious answer under a list of people whose names
 * happen to share three keys.
 *
 * Nothing is offered for one digit: every contact in the business matches a
 * single key, so the list would be the whole database and useless.
 */
export function t9Matches<T extends Dialable>(records: T[], typed: string, limit = 5): Array<T9Hit<T>> {
  const keys = digitsOnly(typed);
  if (keys.length < 2) return [];

  const byNumber: Array<T9Hit<T>> = [];
  const byName: Array<T9Hit<T>> = [];
  for (const record of records) {
    if (record.numbers.some((number) => numberMatchesTyped(number, keys))) {
      byNumber.push({ record, how: 'number' });
    } else if (nameMatchesKeys(record.name, keys)) {
      byName.push({ record, how: 'name' });
    }
  }
  return [...byNumber, ...byName].slice(0, limit);
}

/**
 * The number as it should read while somebody is typing it.
 *
 * Indian mobiles are said aloud as five and five, and a ten-digit run with no
 * grouping is the one thing on this screen somebody has to read back to a
 * customer. A number that is not ten digits is left exactly as typed rather
 * than forced into a shape it does not have — a landline, an extension and a
 * half-typed number are all none of this function's business.
 */
export function groupForDisplay(typed: string): string {
  /*
    A USSD code is not a phone number. `*21#` checks call forwarding and
    `*123#` checks a balance — both are dialled every day in India, and
    stripping the stars to group the digits turns one into the other's
    neighbour. Anything carrying a character a phone number cannot have is
    returned exactly as typed.
  */
  if (!/^\+?[\d\s-]*$/.test(typed)) return typed;

  const digits = digitsOnly(typed);
  const india = typed.trim().startsWith('+91') || digits.startsWith('91');
  const national = india ? digits.replace(/^91/, '') : digits;
  if (national.length > 10) return typed;

  const head = india ? '+91 ' : '';
  if (national.length <= 5) return `${head}${national}`;
  return `${head}${national.slice(0, 5)} ${national.slice(5)}`;
}
