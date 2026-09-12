/**
 * Two habits that made the integration suite fail for reasons that were not
 * about the code.
 *
 * Neither is hypothetical. Both were measured on this repository, and both
 * produce the same kind of bad day: a red run whose message points somewhere
 * other than the cause, on a suite that CI treats as a deploy gate.
 *
 * This runs in the unit suite — it reads files and needs no database — so it
 * answers in milliseconds and cannot itself be flaky.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SUITE = join(dirname(fileURLToPath(import.meta.url)), 'integration');

/** Comments describe the traps; they must not be mistaken for the traps. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function suiteFiles(): { file: string; text: string }[] {
  return readdirSync(SUITE)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => ({ file, text: withoutComments(readFileSync(join(SUITE, file), 'utf8')) }));
}

// ---------------------------------------------------------------------------
// 1. Signing in
// ---------------------------------------------------------------------------

/**
 * Files whose business is authentication itself, so they must call the login
 * endpoint directly and read what comes back — that is the thing under test.
 */
const AUTH_SUITES = new Set([
  'api.test.ts',                         // asserts the login contract, including its failures
  'logoutEndsTheSession.test.ts',
  'pinAuth.test.ts',
  'refreshRotation.test.ts',
  'refreshTokenLivesInACookie.test.ts',
  'theFrontDoorHolds.test.ts',           // brute-force and enumeration behaviour
  'whatARepCanSee.test.ts',              // signs in as several roles and compares
  'fixtures.ts',                         // where `signIn` itself lives
]);

describe('signing in, in the integration suite', () => {
  /*
    Thirty-eight files used to write this out by hand and drop the half that
    matters:

        token = (await request(app).post('/api/auth/login').send(…)).body.token;

    A login that does not answer 200 leaves `token` undefined, every later
    request sends `Bearer undefined`, and the run fails several assertions
    later with "expected 200, got 401" — which reads as a permissions bug in
    whatever happened to be asserted next.

    It has already cost this project once. The brute-force guard is built once
    at module scope in `api/routes/auth.ts`, so every `createApp()` in the
    process shares one budget and the whole suite signs in from one address; it
    reached seventeen of twenty (see the note in `tests/integration/setup.ts`).
    Raising the limit moved the cliff. `signIn` makes falling off it legible.
  */
  it('goes through signIn, so a refused login fails where it happened', () => {
    const offenders: string[] = [];

    for (const { file, text } of suiteFiles()) {
      if (AUTH_SUITES.has(file)) continue;
      if (!text.includes("'/api/auth/login'")) continue;
      offenders.push(file);
    }

    expect(
      offenders,
      'These call /api/auth/login directly. Use `signIn(app, identifier)` from '
      + 'fixtures.js — it throws with the status and body when the login is '
      + 'refused, instead of handing back undefined and failing somewhere else. '
      + 'If the file is genuinely about authentication, add it to AUTH_SUITES.',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Borrowing a row
// ---------------------------------------------------------------------------

/**
 * Tables every other file writes to as it runs, so "whichever row comes first"
 * is decided by what happened to run before.
 *
 * There is a third shape this rule cannot see, and it is worth knowing about
 * because it cost a run too: a test that creates its own records and then
 * asserts their *position in a global list*. `recordNeighbours` made five
 * leads at ₹100–₹500 and asserted the record either side of ₹300 was ₹400 and
 * ₹200 — true only while nothing else in the suite owns a budget in between.
 * It asks the database what the neighbours should be now, and no rule below
 * could have spotted it. If a test knows the answer before it looks, ask
 * whether it could still know it after somebody adds a fixture.
 */
const CHURNED = /\b(ipy_record|ipy_e_leads|ipy_e_properties)\b/i;

/**
 * Files that borrow a row, how many times, and why that is safe there.
 *
 * Borrowing is fine when the test needs *a* record and asserts that something
 * answers. It is not fine when the test asserts on what is *in* the record,
 * because then it is asserting on the luck of the draw.
 *
 * A total order does not rescue the second case: the seed mints fresh UUIDs
 * every run, so "lowest id" is a different row each time.
 *
 * The count is here so that editing one of these queries does not trip the
 * guard, while *adding* a borrow does — at which point the question to answer
 * is which of the two cases above it is.
 */
const ACKNOWLEDGED: { file: string; borrows: number; why: string }[] = [
  { file: 'aiDegradesWithoutAProvider.test.ts', borrows: 1, why: 'needs any lead; asserts no match carries a narrative' },
  { file: 'consentSurvivesDeletedFields.test.ts', borrows: 3, why: 'asserts the do-not-call read answers rather than raising 42703' },
  { file: 'deletedFields.test.ts', borrows: 1, why: 'loadRequirement answers for any lead row; the point is that it answers' },
  { file: 'facebookLeadPipeline.test.ts', borrows: 1, why: 'reads back the lead the test itself just captured, narrowed by its own marker' },
  { file: 'matchingAgreesBothWays.test.ts', borrows: 2, why: 'wants the richest lead by budget; the assertion is that both directions agree on it' },
  { file: 'matchingReadsTheMappedPrice.test.ts', borrows: 1, why: 'needs any property; the lead it asserts on it creates itself' },
  { file: 'matchingSurvivesDeletedFields.test.ts', borrows: 3, why: 'asserts matching answers with a field deleted, whichever record it runs on' },
  { file: 'matchingSurvivesScalarLists.test.ts', borrows: 1, why: 'asserts a scalar stored where a list is expected does not raise' },
  { file: 'publicCatalogueSurvivesTheModel.test.ts', borrows: 1, why: 'needs any published property; asserts the catalogue query answers' },
  { file: 'websiteEnquiryLands.test.ts', borrows: 1, why: 'reads back the enquiry the test just submitted, matched on its own number' },
];

describe('borrowing a seeded row', () => {
  /*
    `propertyNaming.test.ts` is why this exists. It took whichever property
    came back first and then asserted the filename prefix built from it was
    *not* the generic fallback — an assertion about a record it had never seen.
    It failed once in three full runs on an idle machine, and the message
    ("expected 'property' not to be 'property'") said nothing about the cause.
    It makes its own property now.
  */
  it('is acknowledged, with a reason, everywhere it happens', () => {
    const found = new Map<string, number>();

    for (const { file, text } of suiteFiles()) {
      for (const [, sql] of text.matchAll(/`([^`]*\bLIMIT\b[^`]*)`/gis)) {
        const flat = sql.replace(/\s+/g, ' ');
        if (!/\bSELECT\b/i.test(flat) || !CHURNED.test(flat)) continue;
        found.set(file, (found.get(file) ?? 0) + 1);
      }
    }

    const expected = new Map(ACKNOWLEDGED.map((a) => [a.file, a.borrows]));
    const surprises: string[] = [];

    for (const [file, count] of found) {
      const allowed = expected.get(file);
      if (allowed === undefined) surprises.push(`${file} borrows ${count} row(s) and is not acknowledged`);
      else if (allowed !== count) surprises.push(`${file} borrows ${count} row(s), acknowledged for ${allowed}`);
    }
    for (const [file, count] of expected) {
      if (!found.has(file)) surprises.push(`${file} is acknowledged for ${count} but borrows none — remove the entry`);
    }

    expect(
      surprises,
      'A test that takes "whichever row comes first" from a table other tests '
      + 'write to is asserting on what ran before it. If it only needs a record '
      + 'to exist, add it to ACKNOWLEDGED with the reason. If it asserts on what '
      + 'is in the record, create the record instead.',
    ).toEqual([]);
  });
});
