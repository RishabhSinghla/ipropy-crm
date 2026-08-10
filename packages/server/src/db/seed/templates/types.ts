import type { ModuleDef } from '../helpers.js';

/**
 * A starting data model for one trade.
 *
 * The engine has never known what a "lead" or a "property" is — modules, fields,
 * layouts and views are rows it reads at runtime. A template is simply the first
 * set of those rows. Everything in one is editable by an admin afterwards, so a
 * template is a starting point and not a schema.
 *
 * Kept in its own file so a template can name this type without importing the
 * registry that imports it back.
 */
export interface IndustryTemplate {
  /** Stable identifier — stored, referenced by SEED_TEMPLATE, never shown. */
  key: string;
  /** Shown when choosing. */
  label: string;
  /** One line: who this is for and what it gives them. */
  description: string;
  modules: ModuleDef[];
}
