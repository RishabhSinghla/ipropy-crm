/**
 * Structural checks on a starting data model, run before it can reach a database.
 *
 * Everything here is a mistake that is invisible at compile time and expensive
 * afterwards: the types say `labelFields: string[]`, not "field names that exist
 * in this module". Seeding a template whose default view lists a column nobody
 * defined produces a CRM whose list screen is blank, and the seed is idempotent
 * and additive, so the fix is a restore rather than a re-run.
 *
 * Cheap to run and needs no database, so `templates.test.ts` runs it over every
 * registered template on every commit.
 */
import { isSystemField, SYSTEM_FIELDS } from '../../../core/query/builder.js';
import type { FieldDef, ModuleDef } from '../helpers.js';
import type { IndustryTemplate } from './types.js';

/** What Postgres and `quoteIdent()` will accept, which is stricter than TypeScript. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function fieldsOf(module: ModuleDef): FieldDef[] {
  return module.blocks.flatMap((block) => block.fields);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/**
 * Returns a list of problems, empty when the template is sound. A list rather
 * than a thrown error so someone writing a new trade sees everything wrong at
 * once instead of fixing one line per run.
 */
export function validateTemplate(template: IndustryTemplate): string[] {
  const problems: string[] = [];
  const at = (module: string, message: string): void => {
    problems.push(`${template.key}/${module}: ${message}`);
  };

  if (!IDENTIFIER.test(template.key.replace(/-/g, '_'))) {
    problems.push(`${template.key}: key must be lower-case letters, digits and dashes`);
  }
  if (!template.modules.length) problems.push(`${template.key}: has no modules`);

  for (const name of duplicates(template.modules.map((m) => m.name))) {
    problems.push(`${template.key}: two modules are called "${name}"`);
  }
  for (const table of duplicates(template.modules.map((m) => m.table))) {
    problems.push(`${template.key}: two modules share the table "${table}"`);
  }

  const moduleNames = new Set(template.modules.map((m) => m.name));

  for (const module of template.modules) {
    if (!IDENTIFIER.test(module.name)) at(module.name, 'module name is not a valid identifier');
    if (!IDENTIFIER.test(module.table)) at(module.name, `table "${module.table}" is not a valid identifier`);

    const fields = fieldsOf(module);
    const declared = new Set(fields.map((f) => f.name));
    const byName = new Map(fields.map((f) => [f.name, f]));

    // `created_at`, `owner_id` and the rest live on ipy_record and are real on
    // every module without being declared. Asking the query builder rather than
    // keeping a second list here is what stops the two drifting apart.
    const names = { has: (name: string): boolean => declared.has(name) || isSystemField(name) };
    const uitypeOf = (name: string): string | undefined =>
      byName.get(name)?.uitype ?? SYSTEM_FIELDS[name]?.uitype;

    for (const name of duplicates(fields.map((f) => f.name))) {
      at(module.name, `field "${name}" is defined twice`);
    }
    for (const name of duplicates(module.blocks.map((b) => b.name))) {
      at(module.name, `block "${name}" is defined twice`);
    }
    for (const field of fields) {
      if (!IDENTIFIER.test(field.name)) at(module.name, `field "${field.name}" is not a valid identifier`);
    }

    // A module with no label field renders every record as a blank link.
    if (!module.labelFields.length) at(module.name, 'has no labelFields');
    for (const field of module.labelFields) {
      if (!names.has(field)) at(module.name, `labelFields names "${field}", which is not a field here`);
    }

    if (module.pipelineField) {
      const uitype = uitypeOf(module.pipelineField);
      if (!uitype) {
        at(module.name, `pipelineField "${module.pipelineField}" is not a field here`);
      } else if (uitype !== 'picklist') {
        // The board groups by this field's options; anything else has none.
        at(module.name, `pipelineField "${module.pipelineField}" is a ${uitype}, not a picklist`);
      }
    }

    for (const field of module.duplicateCheckFields ?? []) {
      if (!names.has(field)) at(module.name, `duplicateCheckFields names "${field}", which is not a field here`);
    }

    for (const relation of module.relations ?? []) {
      if (!moduleNames.has(relation.target)) {
        at(module.name, `relation "${relation.name}" points at "${relation.target}", which this template does not define`);
      }
    }

    const defaults = (module.views ?? []).filter((v) => v.isDefault);
    if (defaults.length > 1) {
      at(module.name, `${defaults.length} views are marked default; only one tab can be`);
    }
    for (const view of module.views ?? []) {
      for (const column of view.columns) {
        if (!names.has(column)) at(module.name, `view "${view.name}" lists column "${column}", which is not a field here`);
      }
      if (view.sortBy && !names.has(view.sortBy)) {
        at(module.name, `view "${view.name}" sorts by "${view.sortBy}", which is not a field here`);
      }
      if (view.displayMode === 'kanban') {
        const groupBy = view.groupBy ?? module.pipelineField;
        if (!groupBy) at(module.name, `view "${view.name}" is a board with nothing to group by`);
        else if (!names.has(groupBy)) at(module.name, `view "${view.name}" groups by "${groupBy}", which is not a field here`);
      }
    }
  }

  return problems;
}
