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

/**
 * The automation account's fixed id. Every unattended write — website and
 * portal leads, imports, workflows — runs as this row.
 *
 * Production's copy is named "System User" with the address
 * `system@ipropy.com`, which *has* a dot after the `@`, so `isSystemAccount`
 * cannot recognise it by address. The id is what is certain. Read off
 * production on 27 September 2026: it created 48,235 records and 48,254 audit
 * rows and can never log in.
 */
export const AUTOMATION_USER_ID = '00000000-0000-0000-0000-000000000000';
