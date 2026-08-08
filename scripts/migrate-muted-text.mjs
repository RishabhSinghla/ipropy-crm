/**
 * One-shot codemod: raw slate steps → the `text-muted` token, for *text* only.
 *
 * `text-slate-400` is 2.56:1 on white and `text-slate-500` is 3.75:1 on
 * slate-900, so both fail WCAG AA at the 11–14px sizes this app uses them at.
 * `text-muted` resolves to a token that is AA on every surface in both themes
 * (see styles.css). In dark mode the resulting colour is unchanged — #94a3b8
 * either way — so this is a light-mode legibility fix, not a redesign.
 *
 * Only class lists that also carry a font-size utility are touched. The other
 * ~58 uses of these steps are on icons, where the colour is decorative and a
 * darker value would read as a different visual weight.
 *
 * Run: node scripts/migrate-muted-text.mjs [--write]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'packages/web/src';
const WRITE = process.argv.includes('--write');

const HAS_FONT_SIZE = /\btext-(2xs|xs|sm|base|lg|xl|2xl|3xl|\[\d+px\])\b/;
// Not /g — a global regex makes .test() stateful, which would skip every
// second match.
const HAS_MUTED_STEP = /\b(dark:)?text-slate-(400|500)\b/;
const MUTED_STEPS = /\b(dark:)?text-slate-(400|500)\b/g;
const ANY_SLATE_TEXT = /\b(dark:)?text-slate-\d+\b/g;

const tidy = (s) => s.replace(/ {2,}/g, ' ').replace(/^ | $/g, '');

/** Replace the muted steps in one class list with a single token. */
function toToken(body) {
  let first = true;
  return tidy(body.replace(MUTED_STEPS, () => {
    if (!first) return '';
    first = false;
    return 'text-muted';
  }));
}

/**
 * `text-muted` sets both themes, so a plain slate text colour left beside it
 * is a conflict: `text-slate-600 dark:text-slate-400` must collapse to the
 * token alone, not to the token *plus* slate-600. Only unprefixed and `dark:`
 * colours are dropped — hover/focus/group variants are deliberate state
 * changes and stay. Idempotent, so it also repairs an earlier partial run.
 */
function dropConflicts(body) {
  return tidy(body.replace(ANY_SLATE_TEXT, (m, _dark, offset, str) => (
    // A variant prefix (hover:, group-hover:, peer-focus:, sm:) ends in ':'.
    /:$/.test(str.slice(0, offset)) ? m : ''
  )));
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.tsx') || p.endsWith('.ts') ? [p] : [];
  });
}

let files = 0;
let edits = 0;

for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');

  // Any single- or double-quoted string that looks like a Tailwind class list.
  const out = src.replace(/(['"])((?:[^'"\\\n]|\\.)*)\1/g, (whole, quote, body) => {
    const hasToken = body.includes('text-muted');
    const migratable = HAS_FONT_SIZE.test(body) && HAS_MUTED_STEP.test(body);
    if (!hasToken && !migratable) return whole;

    const next = dropConflicts(migratable ? toToken(body) : body);
    if (next === body) return whole;
    edits += 1;
    return `${quote}${next}${quote}`;
  });

  if (out !== src) {
    files += 1;
    if (WRITE) writeFileSync(file, out);
  }
}

console.log(`${WRITE ? 'Rewrote' : 'Would rewrite'} ${edits} class lists across ${files} files.`);
