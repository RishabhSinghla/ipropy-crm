/**
 * Which fields an admin is refused permission to delete.
 *
 * `FIELDS_USED_IN_CODE` is the one place this CRM says no to an admin. Every
 * entry costs somebody a customisation they wanted, so the list has to earn each
 * one, and the test that guards it is about what is *absent* as much as what is
 * present.
 */
import { describe, expect, it } from 'vitest';
import { FIELDS_USED_IN_CODE } from '../src/core/metadata/fieldRename.js';

describe('the fields an admin cannot delete', () => {
  it('names a real consequence for every one of them', () => {
    for (const [key, reason] of Object.entries(FIELDS_USED_IN_CODE)) {
      expect(key, `${key} should be keyed module.field`).toMatch(/^[a-z_]+\.[a-z_]+$/);
      // The message is shown to whoever just tried to delete it, so "it is used
      // internally" is not good enough. It has to say what stops working.
      expect(reason.length, `${key} needs a reason somebody can act on`).toBeGreaterThan(20);
    }
  });

  /**
   * These two carry whole sections of the public website: a project there is not
   * a record, it is units grouped by `project_name`, and the cities page is those
   * units grouped by `city`. Remove either and the section is correctly empty.
   *
   * They were on the list for one day, added on the assumption that whoever
   * deleted them in production had not understood what they carried. They had.
   * This business sells builder floors in one area, so a project grouping and a
   * city filter are both noise on its own site.
   *
   * A CRM whose whole promise is that an admin never needs a developer cannot
   * then refuse a field the admin has decided against. When one of these goes,
   * the website's job is to stop offering the section — not the CRM's job to
   * argue. This test is here so a future well-meaning change does not put the
   * guard back.
   */
  it.each(['properties.project_name', 'properties.city'])(
    'leaves %s deletable, because its owner removed it on purpose',
    (key) => {
      expect(FIELDS_USED_IN_CODE).not.toHaveProperty(key);
    },
  );

  it('still protects what the engine itself reads', () => {
    // The opposite failure: a list this short is only useful if it is not empty.
    for (const key of ['leads.full_name', 'leads.mobile', 'properties.status']) {
      expect(FIELDS_USED_IN_CODE).toHaveProperty(key);
    }
  });
});
