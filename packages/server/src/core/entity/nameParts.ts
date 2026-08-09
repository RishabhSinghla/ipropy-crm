/**
 * Name tokens for merge fields.
 *
 * The lead form now captures one `full_name`, but roughly forty template
 * strings across workflows, WhatsApp templates and email bodies say
 * `{{first_name}}` — and they should keep saying it, because "Hi Rishabh" is
 * the right greeting and "Hi Rishabh Singhla" reads like a bank letter.
 *
 * So rather than rewriting those templates to a field that would produce worse
 * copy, `first_name` and `last_name` become *derived* tokens. Every merge scope
 * runs through here, which means:
 *
 *   * old templates keep working, unchanged;
 *   * records written before the merge, which still have real `first_name`
 *     values in their columns, keep using them;
 *   * a record with only a full name gets sensible halves.
 *
 * Splitting a name is culturally lossy — "Rishabh Kumar Singhla" has no
 * objectively correct split, and plenty of names are one word. The rule here is
 * the least-surprising one: first token is the given name, the remainder is
 * everything else, and a single-word name yields an empty last name rather than
 * repeating itself.
 */

export interface NameParts {
  full_name: string;
  first_name: string;
  last_name: string;
}

export function deriveNameParts(values: Record<string, unknown>): NameParts {
  const stored = (key: string): string => {
    const value = values[key];
    return typeof value === 'string' ? value.trim() : '';
  };

  const explicitFirst = stored('first_name');
  const explicitLast = stored('last_name');

  // `label` last: modules other than leads have no name fields at all, but a
  // template greeting still wants something to say, and the record's display
  // label is the closest thing to a name they have.
  const full = stored('full_name')
    || [explicitFirst, explicitLast].filter(Boolean).join(' ').trim()
    || stored('label');

  if (!full) return { full_name: '', first_name: '', last_name: '' };

  // A real stored value always wins: pre-merge records have accurate halves and
  // second-guessing them would be strictly worse than using them.
  if (explicitFirst) {
    return { full_name: full, first_name: explicitFirst, last_name: explicitLast };
  }

  const tokens = full.split(/\s+/).filter(Boolean);
  return {
    full_name: full,
    first_name: tokens[0] ?? '',
    last_name: tokens.slice(1).join(' '),
  };
}

/**
 * Merge derived name tokens into a scope without clobbering anything real.
 *
 * Mutating a copy rather than the caller's object: merge scopes get reused
 * across several template renders in one workflow run, and a helper that
 * quietly rewrites its input is how one step's data leaks into the next.
 */
export function withNameParts(scope: Record<string, unknown>): Record<string, unknown> {
  const parts = deriveNameParts(scope);
  if (!parts.full_name) return scope;
  return {
    ...scope,
    full_name: parts.full_name,
    first_name: parts.first_name,
    last_name: parts.last_name,
    // The commonest fallback in a greeting: better an impersonal "there" than
    // "Hi ," when a record genuinely has no name.
    name: parts.full_name,
  };
}
