/**
 * The registry of starting data models.
 *
 * Which one a database gets is decided **once, when it is first seeded**, and is
 * a property of that database from then on. Seeding a second template into a
 * database that already holds another does not switch it over: `upsertModule`
 * adds and updates, it never removes, so you would end up with both trades'
 * modules side by side and no way back except a restore. One database, one
 * trade — which is also why the SaaS plan is a database per customer.
 *
 * Adding a trade is a file next to `realEstate.ts` and a line in `TEMPLATES`.
 * `validateTemplate` is what stops a malformed one reaching a real database;
 * it runs over every registered template in the unit suite.
 */
import { REAL_ESTATE } from './realEstate.js';
import type { IndustryTemplate } from './types.js';

export type { IndustryTemplate };

export const TEMPLATES: Record<string, IndustryTemplate> = {
  [REAL_ESTATE.key]: REAL_ESTATE,
};

export const DEFAULT_TEMPLATE_KEY = REAL_ESTATE.key;

export function listTemplates(): IndustryTemplate[] {
  return Object.values(TEMPLATES);
}

/**
 * Resolve a template by key, failing loudly on an unknown one.
 *
 * A typo in `SEED_TEMPLATE` must not quietly fall back to real estate: a gym
 * would be seeded with property fields, and the seed's own idempotence means
 * running it again with the right key afterwards leaves both sets in place.
 */
export function resolveTemplate(key: string = DEFAULT_TEMPLATE_KEY): IndustryTemplate {
  const template = TEMPLATES[key];
  if (!template) {
    throw new Error(
      `Unknown seed template "${key}". Available: ${Object.keys(TEMPLATES).join(', ')}.`,
    );
  }
  return template;
}
