/**
 * The security audit, with an allowlist for advisories nobody can fix.
 *
 * `npm audit` offers no way to say "this one is known and accepted": it fails
 * on any advisory at or above the level you give it, forever, until upstream
 * publishes a fix. Two transitive groups have none:
 *
 *   fast-uri  — via ajv → @modelcontextprotocol/sdk. Four SSRF/host-confusion
 *               advisories; ajv is pinned by the MCP SDK's major.
 *   qs        — via body-parser → express (and superagent). Two DoS advisories;
 *               the fixed lines need express/body-parser majors.
 *
 * Both packages are installed at the newest version npm can resolve. A gate
 * that permanently red is not a gate, it is wallpaper: every run looks the
 * same, so the day a real advisory lands nobody will look. This reads the same
 * `npm audit --json` report and fails ONLY on an advisory that is not on the
 * allowlist below.
 *
 * The allowlist is a decision, not a shrug — each entry names what would get
 * rid of it. When an entry stops appearing in the report (upstream fixed it,
 * or a dependency moved on), the script says so and the entry should be
 * deleted. It prints a warning rather than failing: turning good news into a
 * red build is how audits learned to be ignored in the first place.
 *
 * Usage in CI:  npm audit --json | node scripts/security-audit.mjs
 */
import { readFileSync } from 'node:fs';

// GHSA id → why it is accepted, and what retires it.
//
// Empty, and that is the goal state rather than an oversight.
//
// Six advisories lived here — four in fast-uri, two in qs — and all six are now
// genuinely fixed rather than accepted. qs went with the Express 5 upgrade:
// Express 4 pinned `qs` to `~6.15.1`, so the patched 6.16.0 was outside the
// range no matter what any override said, and only the major upgrade opened it.
// fast-uri needed nothing but `npm update` once the tree would re-resolve.
//
// Keep the machinery. An advisory with no upstream fix will land again, and the
// alternative to a named allowlist is either a permanently red gate that
// everybody learns to ignore, or no gate at all.
const ALLOWED = new Map([]);

let raw;
try {
  raw = readFileSync(0, 'utf8');
} catch {
  console.error('security-audit: could not read the npm audit report on stdin.');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('security-audit: npm audit did not produce valid JSON — treating as a failure.');
  process.exit(1);
}

// npm's JSON nests advisories under vulnerabilities[name].via; an entry is
// either an advisory object or a string naming the package that dragged this
// one in. The object's `source` is npm's numeric advisory id — the readable
// GHSA id lives in the advisory URL (older npm carried it in `id`).
const found = new Map(); // GHSA id → package names that bring it in
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object') continue;
    const id = via.id ?? (typeof via.url === 'string' ? via.url.split('/').pop() : null);
    if (!id) continue;
    if (!found.has(id)) found.set(id, []);
    found.get(id).push(name);
  }
}

if (found.size === 0) {
  console.log('security-audit: no known vulnerabilities.');
  process.exit(0);
}

const unknown = [...found.keys()].filter((id) => !ALLOWED.has(id));
const stale = [...ALLOWED.keys()].filter((id) => !found.has(id));

for (const [id, names] of found) {
  const tag = ALLOWED.has(id) ? 'accepted' : 'NEW';
  console.log(`  ${tag}  ${id}  (${[...new Set(names)].join(', ')})${ALLOWED.has(id) ? ` — ${ALLOWED.get(id)}` : ''}`);
}

if (unknown.length) {
  console.error(
    `\nsecurity-audit: ${unknown.length} advisory(ies) not on the allowlist. ` +
      'Fix them, or add them with a reason and a retirement path.',
  );
  process.exit(1);
}

if (stale.length) {
  console.warn(
    `\nsecurity-audit: ${stale.length} allowlist entry(ies) no longer reported — ` +
      'upstream fixed or dropped them. Delete them from scripts/security-audit.mjs.',
  );
}

console.log('security-audit: only accepted advisories remain. Passing.');
