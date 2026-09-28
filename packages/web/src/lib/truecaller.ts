/**
 * Which boxes on an enquiry form a verified profile fills.
 *
 * A web form's fields are whatever an admin configured, so nothing here may
 * name one field and hope. These two read the form it is actually rendering,
 * and answer null when it has no such box — in which case the verification
 * still happens and the server still records the proven number, there is just
 * nothing on screen to fill in.
 *
 * Pure and node-tested, because getting it wrong is silent: the visitor taps
 * Verify, Truecaller says yes, and the form sits there unchanged.
 */
export interface FormFieldName {
  name: string;
}

/** The first box that is plainly for a phone number. */
export function phoneFieldName(fields: FormFieldName[]): string | null {
  return fields.find((f) => /mobile|phone|contact_?no|whatsapp/i.test(f.name))?.name ?? null;
}

/**
 * The first box that is plainly for a name.
 *
 * `first_name` is preferred over `last_name` when a form has both, because a
 * profile gives one whole name and putting "Riya Sharma" in the surname box is
 * worse than putting it in the first-name one.
 */
export function nameFieldName(fields: FormFieldName[]): string | null {
  const named = fields.filter((f) => /name/i.test(f.name));
  if (!named.length) return null;
  const preferred = named.find((f) => /full_?name|^name$|first_?name/i.test(f.name));
  return (preferred ?? named[0]).name;
}

/** How long to keep asking the server whether the person has finished. */
export const VERIFY_POLL_INTERVAL_MS = 2000;
export const VERIFY_POLL_ATTEMPTS = 30;
