/**
 * The order a record's photos are shown in, defined once.
 *
 * Four places render the same set of photos to four different audiences — the
 * record's carousel, the Files tab, a share link sent to a buyer, and the
 * public catalogue — and until somebody arranged them they each ordered by
 * some variation of "when it was shot". They did not agree: the share link
 * grouped by `ai_category` first, the Files tab did not, so the photo a rep
 * saw leading a property was not the one the buyer got. Whichever order is
 * right, it has to be the same order.
 *
 * `sort_order` is the arrangement somebody made and it wins outright. It is
 * NULL on every photo nobody has touched, and NULLs sort last, so an
 * un-arranged property keeps the capture order exactly as before —
 * chronological, which is the order the floor was walked in.
 *
 * The alias is a literal from calling code, never user input: this is a raw
 * SQL fragment and interpolating anything else into it would be the injection
 * CLAUDE.md rule 6 exists to prevent.
 */
export function photoOrderBy(alias = 'a'): string {
  const a = alias ? `${alias}.` : '';
  return `${a}sort_order NULLS LAST, ${a}captured_at NULLS LAST`;
}

/** The most-used form, for queries that alias the attachment table as `a`. */
export const PHOTO_ORDER = photoOrderBy('a');
