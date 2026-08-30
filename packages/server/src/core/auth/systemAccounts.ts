/**
 * Telling an automation account apart from a person.
 *
 * `system@ipropy` is not somebody who works here. It is the actor that workflow
 * tasks, telephony logging, lead capture and AI field writes all run as, and
 * every one of those paths creates it on demand if it is missing. So deleting it
 * does not stop anything — it makes a second one, orphans everything the first
 * one owned, and splits the audit trail in half with nothing to show for it.
 *
 * The rule this codebase already uses is that a person's address has a dot after
 * the `@` and a system account does not. It is not a general definition of a
 * valid email and is not meant to be; it is the one distinction that keeps a
 * cleanup script from deleting the automation.
 */
export function isSystemAccount(email: string): boolean {
  return !/@[^@\s]+\.[^@\s]+$/.test(email.trim());
}
