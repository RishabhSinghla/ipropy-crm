import type { ModuleMeta } from '@ipropy/shared';

/**
 * What a new record starts with.
 *
 * The engine has always applied these on save — a field's own default, or the
 * option starred as default in Admin → Dropdowns — but the form did not show
 * them, so a mandatory dropdown with a default was a required field the user
 * had to fill in by hand and the star in the dropdown editor did nothing they
 * could see. Filling them in here means the form and the server agree, and
 * "Lifecycle Stage: Lead" is simply already there.
 */
export function startingValues(module: ModuleMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of module.fields) {
    if (!field.isActive || field.displayType === 'detail_only') continue;
    if (field.defaultValue !== null && field.defaultValue !== undefined) {
      out[field.name] = field.defaultValue;
      continue;
    }
    const starred = field.options?.find((o) => o.isDefault);
    // A multi-select holds a list even when only one option is starred; writing
    // the bare string would fail coercion on save.
    if (starred) {
      out[field.name] = field.uitype === 'multipicklist' || field.uitype === 'tags'
        ? [starred.value]
        : starred.value;
    }
  }
  return out;
}
