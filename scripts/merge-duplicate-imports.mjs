/**
 * Merge duplicate imports from the same module.
 *
 * The codebase grew the habit of importing a type and a value from the same
 * module in two statements (e.g. `import type { JSX } from 'react'` next to
 * `import { useState } from 'react'`). ESLint's no-duplicate-imports flags
 * each one, and merging the lines is mechanical but exactly the sort of edit a
 * person gets wrong on the 80th file. This does it carefully:
 *
 *   import type { JSX } from 'react';
 *   import { useState } from 'react';
 *   → import { useState, type JSX } from 'react';
 *
 * Safety rules:
 *   - only single-line import statements without trailing comments are merged
 *   - a namespace import (`import * as ns`) is never merged with anything
 *   - at most one default binding survives, never more than one import line
 *     per module specifier
 *
 * Usage: node scripts/merge-duplicate-imports.mjs [file...]
 * With no file arguments it walks packages/{shared,server,web,mcp} and scripts.
 * It rewrites in place and prints a count; run `npm run typecheck` afterwards.
 */
import { globSync, readFileSync, writeFileSync } from 'node:fs';

const [,, ...only] = process.argv;
const files = only.length
  ? only
  : (globSync([
    'packages/shared/src/**/*.{ts,tsx}',
    'packages/server/src/**/*.{ts,tsx}',
    'packages/server/tests/**/*.{ts,tsx}',
    'packages/web/src/**/*.{ts,tsx}',
    'packages/web/tests/**/*.{ts,tsx}',
    'packages/mcp/src/**/*.{ts,tsx}',
    'scripts/**/*.{js,mjs}',
  ]));

// import statement → { specifier, default?: string, namespace?: string, named: {name, typeOnly, alias}[] }
function parseImport(lineText) {
  const m = lineText.match(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];$/);
  if (!m) return null;
  const specifier = m[2];
  let bindings = m[1];
  const entry = { specifier, default: null, namespace: null, named: [] };
  if (bindings.startsWith('* as ')) {
    entry.namespace = bindings.slice(5).trim();
    return entry;
  }
  /*
    `import type { A, B } from 'x'` — the statement-level type-only form.

    Without this it falls through to the default-binding branch below, because
    `type { A, B }` neither starts with `{` nor matches the `Default, {…}`
    shape. The whole clause was then stored as the "default" and re-emitted
    verbatim beside the other import's braces, producing
    `import type { A }, { B } from 'x'` — which is not valid TypeScript and
    stops the server booting. It broke 57 files.

    Marking every binding type-only here is what lets renderImport spell them
    back inline as `{ B, type A }`, which is what this script's own
    documentation always said it would do.
  */
  let statementTypeOnly = false;
  if (/^type\s*\{/.test(bindings)) {
    statementTypeOnly = true;
    bindings = bindings.replace(/^type\s*/, '');
  }

  const defaultM = bindings.match(/^([A-Za-z_$][\w$]*)\s*,\s*(.+)$/);
  if (defaultM) {
    entry.default = defaultM[1];
    bindings = defaultM[2];
  } else if (!bindings.startsWith('{')) {
    entry.default = bindings;
    return entry;
  }
  const namedM = bindings.match(/^\{(.+)\}$/);
  if (!namedM) return null;
  const body = namedM[1];
  const items = body.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    /*
      Per item, not per statement. This read the first binding and applied its
      type-ness to every one, so `{ type A, B }` came back with B marked as a
      type — which compiles until something imports B for its value and then
      does not.
    */
    const itemTypeOnly = statementTypeOnly || /^type\s+/.test(item);
    const parts = item.replace(/^type\s+/, '').split(/\s+as\s+/);
    entry.named.push({
      name: parts[0].trim(),
      alias: parts[1]?.trim() ?? null,
      typeOnly: itemTypeOnly,
    });
  }
  return entry;
}

function renderImport(entry) {
  if (entry.namespace) return `import * as ${entry.namespace} from '${entry.specifier}';`;
  const parts = [];
  if (entry.default) parts.push(entry.default);
  if (entry.named.length) {
    // Keyed by alias when aliased, since the alias is what the file sees.
    const seen = new Map();
    for (const b of entry.named) {
      const key = b.alias ?? b.name;
      // A binding imported as a value elsewhere in the file wins over a
      // type-only spelling — `import { X, type Y }`.
      if (seen.has(key)) {
        if (!b.typeOnly) seen.set(key, false);
      } else {
        seen.set(key, b.typeOnly);
      }
    }
    const rendered = [...seen.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, typeOnly]) => {
        const orig = entry.named.find((x) => (x.alias ?? x.name) === key);
        const name = orig?.name ?? key;
        const alias = orig?.alias ? ` as ${orig.alias}` : '';
        return `${typeOnly ? 'type ' : ''}${name}${alias}`;
      })
      .join(', ');
    parts.push(`{ ${rendered} }`);
  }
  return `import ${parts.join(', ')} from '${entry.specifier}';`;
}

let mergedFiles = 0;
let removedLines = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  // Group specifier → parsed import lines.
  const grouped = new Map();

  for (let i = 0; i < lines.length; i++) {
    const entry = parseImport(lines[i]);
    if (!entry || entry.namespace) continue;
    const key = entry.specifier;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ index: i, entry, raw: lines[i] });
  }

  const unlink = new Set();
  for (const [key, group] of grouped) {
    if (group.length < 2) continue;
    // A duplicate where one spelling has a default and another also has a
    // default is genuinely ambiguous — refuse rather than guess.
    const defaults = group.filter((g) => g.entry.default);
    if (defaults.length > 1) continue;
    const merged = {
      specifier: key,
      default: defaults[0]?.entry.default ?? null,
      namespace: null,
      named: group.flatMap((g) => g.entry.named),
    };
    const output = renderImport(merged);
    const keepIndex = group[0].index;
    lines[keepIndex] = output;
    for (const g of group.slice(1)) unlink.add(g.index);
    mergedFiles += 1;
  }

  if (unlink.size) {
    const next = lines.filter((_, i) => !unlink.has(i));
    writeFileSync(file, next.join('\n'));
    removedLines += unlink.size;
  }
}

console.log(`merged ${removedLines} duplicate import line(s) across ${files.length} file(s) (${mergedFiles} merges)`);