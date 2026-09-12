/**
 * What a row in the app says.
 *
 * These are not cosmetic. Every one of them pins a rule that decides whether a
 * rep can recognise somebody in a list without reading it, and two of them pin
 * bugs that shipped: a second line that was always empty, and a number shown
 * as national digits with no country.
 */
import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { hueFor, initialsOf, phoneOf, secondLine, shortTime } from '../src/mobile/rows';

/** Only the parts of a field these rules read. */
function field(name: string, uitype: string, extra: Partial<FieldMeta> = {}): FieldMeta {
  return { name, uitype, label: name, config: {}, ...extra } as unknown as FieldMeta;
}

function fieldsOf(...defs: FieldMeta[]): Map<string, FieldMeta> {
  return new Map(defs.map((f) => [f.name, f]));
}

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Priya Sharma')).toBe('PS');
    expect(initialsOf('Rakesh Kumar Bhandari')).toBe('RB');
  });

  it('takes two letters from a single word', () => {
    expect(initialsOf('Infosys')).toBe('IN');
  });

  it('never renders empty, because a blank circle reads as a broken image', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('avatar colour', () => {
  it('is the same every time for the same person', () => {
    expect(hueFor('Priya Sharma')).toBe(hueFor('Priya Sharma'));
  });

  it('is a hue the palette actually contains', () => {
    for (const name of ['Priya', 'Rakesh', 'Sunita', 'Arjun', 'Neha', '']) {
      expect(hueFor(name)).toBeGreaterThanOrEqual(0);
      expect(hueFor(name)).toBeLessThan(360);
    }
  });
});

describe('the second line', () => {
  const fields = fieldsOf(
    field('full_name', 'text'),
    field('mobile', 'phone'),
    field('lead_status', 'picklist'),
    field('contact_type', 'picklist'),
  );

  it('shows the number and the stage', () => {
    const line = secondLine(
      {
        label: 'Priya Sharma',
        values: { mobile: '9876543210', lead_status: 'Qualified' },
        display: { mobile: '+91 9876543210', lead_status: 'Qualified' },
      },
      fields,
      'lead_status',
    );
    expect(line).toBe('+91 9876543210 · Qualified');
  });

  /*
    The bug this pins: the number was read out of `values`, which holds
    national digits with no country. Every row in the list read `9876543210`,
    which is not a number anybody in this business would recognise as complete.
  */
  it('prefers the formatted value over the raw one', () => {
    const line = secondLine(
      { label: 'X', values: { mobile: '9876543210' }, display: { mobile: '+91 9876543210' } },
      fields,
      null,
    );
    expect(line).toBe('+91 9876543210');
  });

  it('falls back to any dropdown when there is no phone and no pipeline', () => {
    const line = secondLine(
      { label: 'B-110', values: { contact_type: 'Buyer' }, display: { contact_type: 'Buyer' } },
      fields,
      null,
    );
    expect(line).toBe('Buyer');
  });

  /*
    A module whose pipeline field *is* its label — or whose only filled field
    repeats the name — printed the name twice, one above the other, which reads
    as a rendering fault rather than as data.
  */
  it('never repeats the name underneath itself', () => {
    const line = secondLine(
      { label: 'Priya Sharma', values: { full_name: 'Priya Sharma' }, display: {} },
      fieldsOf(field('full_name', 'picklist')),
      'full_name',
    );
    expect(line).toBe('');
  });

  it('is empty rather than wrong when nothing is filled in', () => {
    expect(secondLine({ label: 'X', values: {}, display: {} }, fields, 'lead_status')).toBe('');
  });

  it('skips an empty list, which is a value and not a null', () => {
    const line = secondLine(
      { label: 'X', values: { tags: [] }, display: {} },
      fieldsOf(field('tags', 'picklist')),
      null,
    );
    expect(line).toBe('');
  });
});

describe('the number to dial', () => {
  const fields = fieldsOf(field('full_name', 'text'), field('mobile', 'phone'));

  it('puts the country back on the front', () => {
    const phone = phoneOf({ values: { country_code: 'India', mobile: '9876543210' } }, fields);
    expect(phone).toBe('+919876543210');
  });

  /*
    `country_code` is the default and not a certainty — a second phone field
    names its own companion through `config.countryField`. Assuming the default
    dials an Indian number for a Dubai contact.
  */
  it('reads the country field the field itself names', () => {
    const withCompanion = fieldsOf(
      field('alt_phone', 'phone', { config: { countryField: 'alt_country' } } as Partial<FieldMeta>),
    );
    const phone = phoneOf({ values: { alt_country: 'India', alt_phone: '9812345678' } }, withCompanion);
    expect(phone).toBe('+919812345678');
  });

  it('is null when there is nothing to ring', () => {
    expect(phoneOf({ values: {} }, fields)).toBeNull();
    expect(phoneOf({ values: { mobile: '' } }, fields)).toBeNull();
  });
});

describe('the time on the right', () => {
  const now = new Date('2026-09-12T11:00:00+05:30');

  /*
    Asserted by shape, not by the rendered string.

    `toLocaleTimeString` formats in the *runner's* timezone, and that is
    correct behaviour: a rep's phone is set to where they are, and a CRM that
    printed times in the server's zone would be wrong on every handset. But it
    makes an exact-value assertion a test that passes in India and fails in CI,
    which is what this one did — `9:30 am` on a laptop in IST, `4:00 am` on a
    runner in UTC.

    What the rule actually promises is which *form* a time takes, and that is
    the same everywhere.
  */
  const CLOCK = /^\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?$/i;

  it('shows a clock time for today', () => {
    expect(shortTime('2026-09-12T09:30:00+05:30', now)).toMatch(CLOCK);
  });

  it('does not show a clock time for anything older', () => {
    expect(shortTime('2026-09-09T09:30:00+05:30', now)).not.toMatch(CLOCK);
    expect(shortTime('2026-07-02T09:30:00+05:30', now)).not.toMatch(CLOCK);
  });

  it('shows the weekday within the last week', () => {
    expect(shortTime('2026-09-09T09:30:00+05:30', now)).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it('shows a date beyond that', () => {
    expect(shortTime('2026-07-02T09:30:00+05:30', now)).toMatch(/Jul/);
  });
});
