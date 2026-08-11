/**
 * Coercing spoken values.
 *
 * This is the last thing standing between a misheard sentence and a property
 * listed at the wrong crore figure, so it is tested harder than its size
 * suggests — including the cases where the right answer is to refuse.
 */
import { describe, expect, it } from 'vitest';
import type { FieldMeta } from '@ipropy/shared';
import { coerceSpokenValue, matchOption } from '../../src/core/capture/spoken.js';

/** Enough of a FieldMeta for coercion; the rest is irrelevant to it. */
const field = (uitype: string, name = 'f'): FieldMeta => ({
  name, label: name, uitype, storage: 'column', columnName: name,
  isMandatory: false, isReadonly: false, isUnique: false, isActive: true,
  displayType: 'default', sequence: 0, config: {},
  quickCreate: false, massEditable: true, searchable: false,
} as unknown as FieldMeta);

describe('coerceSpokenValue', () => {
  describe('money — the value most worth getting right', () => {
    const price = field('currency', 'total_price');

    it('reads the Indian units a person actually says', () => {
      expect(coerceSpokenValue(price, '3.25 cr')).toBe(32_500_000);
      expect(coerceSpokenValue(price, '1.85 crore')).toBe(18_500_000);
      expect(coerceSpokenValue(price, '85 lakh')).toBe(8_500_000);
      expect(coerceSpokenValue(price, '₹2.4 Cr')).toBe(24_000_000);
      // "lacs" is the ordinary spelling in Indian listings — commoner than
      // "lakhs" — and parseIndianPrice did not accept it, so this was a
      // silently dropped price on typed input and CSV import too.
      expect(coerceSpokenValue(price, '45 lacs')).toBe(4_500_000);
      expect(coerceSpokenValue(price, '1.5 Cr.')).toBe(15_000_000);
    });

    it('takes a plain number as rupees', () => {
      expect(coerceSpokenValue(price, '12500000')).toBe(12_500_000);
      expect(coerceSpokenValue(price, '1,25,00,000')).toBe(12_500_000);
    });

    it('refuses what it cannot read rather than guessing', () => {
      // Absent beats wrong: the review screen shows an empty price, which is
      // obvious, instead of a plausible one that is off by a factor of ten.
      expect(coerceSpokenValue(price, 'around three and a half')).toBeUndefined();
      expect(coerceSpokenValue(price, 'negotiable')).toBeUndefined();
      expect(coerceSpokenValue(price, '')).toBeUndefined();
      expect(coerceSpokenValue(price, '0')).toBeUndefined();
    });
  });

  describe('numbers carry their unit in speech', () => {
    it('takes the first number and leaves the unit to the field', () => {
      expect(coerceSpokenValue(field('area', 'carpet_area'), '325 gaj')).toBe(325);
      expect(coerceSpokenValue(field('area'), '2400 sq ft')).toBe(2400);
      expect(coerceSpokenValue(field('integer', 'floor'), '2nd')).toBe(2);
      expect(coerceSpokenValue(field('integer', 'parking'), 'two')).toBeUndefined();
    });

    it('does not smear separate numbers together', () => {
      // Stripping every non-digit would turn this into 32.
      expect(coerceSpokenValue(field('integer'), '3 BHK 2 bath')).toBe(3);
    });

    it('rounds for integer fields but not decimal ones', () => {
      expect(coerceSpokenValue(field('integer'), '2.6')).toBe(3);
      expect(coerceSpokenValue(field('decimal'), '2.6')).toBe(2.6);
    });
  });

  describe('picklists only ever get real options', () => {
    const facing = field('picklist', 'facing');
    const options = ['North', 'South', 'East', 'West', 'North-East'];

    it('matches however it was said', () => {
      expect(coerceSpokenValue(facing, 'East', options)).toBe('East');
      expect(coerceSpokenValue(facing, 'east', options)).toBe('East');
      expect(coerceSpokenValue(facing, 'north east', options)).toBe('North-East');
      expect(coerceSpokenValue(facing, 'East facing', options)).toBe('East');
    });

    it('refuses a value that is not an option', () => {
      // A picklist that accepts freehand text stops grouping, filtering and
      // reporting — the three reasons it is a picklist.
      expect(coerceSpokenValue(facing, 'sort of eastish', options)).toBeUndefined();
      expect(coerceSpokenValue(facing, 'Northwest', options)).toBeUndefined();
    });

    it('wraps a multipicklist value in an array', () => {
      expect(coerceSpokenValue(field('multipicklist'), 'Lift', ['Lift', 'Pool'])).toEqual(['Lift']);
    });
  });

  describe('yes and no, in both languages people use', () => {
    const lift = field('boolean', 'has_lift');
    it('reads either', () => {
      expect(coerceSpokenValue(lift, 'yes')).toBe(true);
      expect(coerceSpokenValue(lift, 'haan')).toBe(true);
      expect(coerceSpokenValue(lift, 'no')).toBe(false);
      expect(coerceSpokenValue(lift, 'nahi')).toBe(false);
    });
    it('leaves anything ambiguous alone', () => {
      expect(coerceSpokenValue(lift, 'maybe')).toBeUndefined();
      expect(coerceSpokenValue(lift, 'under construction')).toBeUndefined();
    });
  });

  describe('contact details', () => {
    it('keeps the last ten digits of a dictated mobile', () => {
      expect(coerceSpokenValue(field('phone'), '98 111 22333')).toBe('9811122333');
      expect(coerceSpokenValue(field('phone'), '+91 98111 22333')).toBe('9811122333');
    });

    it('refuses a number too short to be one', () => {
      expect(coerceSpokenValue(field('phone'), '98111')).toBeUndefined();
    });

    it('refuses a dictated email unless it is actually well-formed', () => {
      // Spoken addresses are nearly always wrong, and a wrong one fails
      // silently at send time.
      expect(coerceSpokenValue(field('email'), 'sharma at gmail dot com')).toBeUndefined();
      expect(coerceSpokenValue(field('email'), 'Sharma@Gmail.com')).toBe('sharma@gmail.com');
    });
  });

  it('trims and caps free text', () => {
    expect(coerceSpokenValue(field('string'), '  corner plot  ')).toBe('corner plot');
    expect(String(coerceSpokenValue(field('textarea'), 'x'.repeat(900)))).toHaveLength(500);
  });
});

describe('matchOption', () => {
  it('will not match a denial as a confirmation', () => {
    // The dangerous one: "no parking" must not select "Parking" and give the
    // property an amenity the speaker just said it lacks.
    expect(matchOption('no covered parking', ['Covered Parking'])).toBe('Covered Parking');
    expect(matchOption('parking', ['Covered Parking'])).toBeNull();
  });

  it('respects word boundaries', () => {
    expect(matchOption('northeast corner', ['East'])).toBeNull();
    expect(matchOption('facing east side', ['East'])).toBe('East');
  });

  it('returns null rather than a near miss', () => {
    expect(matchOption('bungalow', ['Builder Floor', 'Plot'])).toBeNull();
  });
});
