/**
 * Which records can be sent to somebody outside the CRM.
 *
 * One definition, read by the web record page and by the app. It used to be the
 * literal `moduleName === 'properties'` written inline in `RecordDetail`, and a
 * second copy of that in the app would be the shape of mistake this codebase
 * has paid for repeatedly: two places that agree until one of them is edited.
 *
 * The server does not restrict it — `/:module/:id/share-links` works for any
 * module. The restriction is real all the same, and it is about the *other*
 * end: `/s/:token` renders a property, with photos, a price and a floor plan.
 * Pointing it at a person would show a buyer somebody's phone number and
 * budget.
 *
 * So an admin can turn it on per module (`settings.shareable`), and properties
 * are the default because that is the module the public page was built for.
 */
/**
 * Takes the name and the settings rather than a module object, because the two
 * callers hold different shapes of one — the record page has the name in the
 * URL and the metadata separately, the app has a whole `ModuleMeta`. A
 * parameter each is what lets one rule serve both without either having to
 * assemble an object to ask a question.
 */
export function canShareRecords(
  moduleName: string | undefined,
  settings?: Record<string, unknown> | null,
): boolean {
  if (!moduleName) return false;
  const configured = settings?.shareable;
  if (typeof configured === 'boolean') return configured;
  /*
    The default, and the behaviour before this was a setting. Named rather than
    inferred because there is nothing on a module that says "the public share
    page knows how to render this" — that knowledge lives in
    `pages/SharedProperty.tsx`, and until a second such page exists this is an
    honest constant rather than a guess dressed up as one.
  */
  return moduleName === 'properties';
}
