/**
 * Every registered starting data model has to be structurally sound.
 *
 * This is the guard that makes "adding a trade is a data file" safe to say out
 * loud. Seeding is additive and idempotent, so a template with a view listing a
 * column nobody defined is not fixed by correcting it and re-running — the
 * broken rows are already in the database. Catching it here costs milliseconds.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE_KEY, listTemplates, resolveTemplate, TEMPLATES } from '../../src/db/seed/templates/index.js';
import { validateTemplate } from '../../src/db/seed/templates/validate.js';
import type { IndustryTemplate } from '../../src/db/seed/templates/types.js';

describe('industry templates', () => {
  it('registers at least one', () => {
    expect(listTemplates().length).toBeGreaterThan(0);
  });

  it('keys the registry by each template\'s own key', () => {
    for (const [key, template] of Object.entries(TEMPLATES)) {
      expect(template.key).toBe(key);
    }
  });

  it('resolves the default without being asked', () => {
    expect(resolveTemplate().key).toBe(DEFAULT_TEMPLATE_KEY);
  });

  it('refuses an unknown key rather than falling back', () => {
    // Falling back would seed a gym with property fields, and the seed cannot
    // be undone by running it again with the right key.
    expect(() => resolveTemplate('gyms')).toThrow(/Unknown seed template/);
  });

  it.each(listTemplates().map((t) => [t.key, t] as const))('%s is sound', (_key, template) => {
    expect(validateTemplate(template)).toEqual([]);
  });

  it('still ships the real-estate model iPropy runs on', () => {
    /*
      Three modules since 5 October 2026, and the number is asserted rather than
      merely allowed to grow: eleven modules were deleted from this CRM
      (migrations 030, 031, 048) because each existed only to carry a value a
      lead or a unit could hold itself, and this assertion is what makes adding a
      twelfth a deliberate act rather than a drift.

      `builder_floors` earned its place on the one test that matters: it holds a
      fact neither other module can. A floor's price is per floor, and a
      property's identity is a unique `mobile` — one builder's number owning five
      buildings is twenty floors, nineteen of which that column refuses.
    */
    const modules = resolveTemplate('real-estate').modules.map((m) => m.name).sort();
    expect(modules).toEqual(['builder_floors', 'leads', 'properties']);
  });
});

describe('validateTemplate', () => {
  const base = (): IndustryTemplate => ({
    key: 'test',
    label: 'Test',
    description: 'Fixture.',
    modules: [{
      name: 'clients', label: 'Clients', singular: 'Client', table: 'ipy_e_clients',
      icon: 'users', color: '#000000', sequence: 10,
      labelFields: ['full_name'],
      blocks: [{
        name: 'basics',
        label: 'Basics',
        fields: [
          { name: 'full_name', label: 'Full Name', uitype: 'string', column: 'full_name' },
          { name: 'stage', label: 'Stage', uitype: 'picklist', column: 'stage' },
        ],
      }],
    }],
  });

  it('passes a sound one', () => {
    expect(validateTemplate(base())).toEqual([]);
  });

  it('catches a label field that does not exist', () => {
    const template = base();
    template.modules[0].labelFields = ['name'];
    expect(validateTemplate(template)).toEqual([
      'test/clients: labelFields names "name", which is not a field here',
    ]);
  });

  it('catches a view listing a column nobody defined', () => {
    const template = base();
    template.modules[0].views = [{ name: 'All', columns: ['full_name', 'mobile'] }];
    expect(validateTemplate(template)).toContain(
      'test/clients: view "All" lists column "mobile", which is not a field here',
    );
  });

  it('catches a pipeline field that is not a picklist', () => {
    const template = base();
    template.modules[0].pipelineField = 'full_name';
    expect(validateTemplate(template)).toContain(
      'test/clients: pipelineField "full_name" is a string, not a picklist',
    );
  });

  it('catches a relation pointing outside the template', () => {
    const template = base();
    template.modules[0].relations = [{
      name: 'invoices', label: 'Invoices', target: 'invoices', type: 'one_to_many',
    }];
    expect(validateTemplate(template)).toContain(
      'test/clients: relation "invoices" points at "invoices", which this template does not define',
    );
  });

  it('catches two views both claiming to be the default tab', () => {
    const template = base();
    template.modules[0].views = [
      { name: 'All', columns: ['full_name'], isDefault: true },
      { name: 'Mine', columns: ['full_name'], isDefault: true },
    ];
    expect(validateTemplate(template)).toContain(
      'test/clients: 2 views are marked default; only one tab can be',
    );
  });

  it('reports every problem at once, not the first', () => {
    const template = base();
    template.modules[0].labelFields = ['nope'];
    template.modules[0].pipelineField = 'also_nope';
    expect(validateTemplate(template)).toHaveLength(2);
  });
});
