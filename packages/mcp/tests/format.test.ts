import { describe, expect, it } from 'vitest';
import { budgetRange, indianPrice, leadSummary, list } from '../src/format.js';

describe('prices, the way the trade says them', () => {
  it('uses crore and lakh, not millions', () => {
    expect(indianPrice(21_500_000)).toBe('₹2.15 Cr');
    expect(indianPrice(8_500_000)).toBe('₹85 L');
    expect(indianPrice(45_000)).toBe('₹45,000');
  });

  it('drops trailing zeros so ₹2 Cr is not ₹2.00 Cr', () => {
    expect(indianPrice(20_000_000)).toBe('₹2 Cr');
    expect(indianPrice(25_000_000)).toBe('₹2.5 Cr');
  });

  it('treats no price as no price, not as zero', () => {
    // A unit awaiting its price must not read as "₹0" — a model would relay
    // that as a fact about the unit.
    expect(indianPrice(null)).toBeNull();
    expect(indianPrice(0)).toBeNull();
    expect(indianPrice(undefined)).toBeNull();
  });
});

describe('budget ranges with one end missing', () => {
  it('reads naturally whichever end is known', () => {
    expect(budgetRange(18_000_000, 24_000_000)).toBe('₹1.8 Cr–₹2.4 Cr');
    expect(budgetRange(null, 24_000_000)).toBe('up to ₹2.4 Cr');
    expect(budgetRange(18_000_000, null)).toBe('₹1.8 Cr+');
    expect(budgetRange(null, null)).toBeNull();
  });
});

describe('a lead as a rep would describe one', () => {
  const lead = {
    id: 'abc',
    label: 'Riya Sharma',
    recordNumber: 'LD-00025',
    values: {
      mobile: '9910190056',
      country_code: '+91',
      budget: 25_000_000,
      configuration: ['2 BHK', '3 BHK'],
      kyc_status: 'Not Started',
      do_not_call: false,
      address: {},
    },
    display: { status: 'Negotiation' },
  };

  it('puts the number back together from its two halves', () => {
    // Migration 026 split the phone into a country code and national digits.
    // Reading only `mobile` hands a model a number it will recite wrong.
    expect(leadSummary(lead)).toContain('Mobile: +91 9910190056');
  });

  it('leads with what matters and leaves out what does not', () => {
    const out = leadSummary(lead);
    expect(out).toContain('Riya Sharma (LD-00025)');
    expect(out).toContain('Budget: ₹2.5 Cr');
    expect(out).toContain('Status: Negotiation');
    // Empty and irrelevant fields are noise that costs tokens and buries the
    // four facts that matter.
    expect(out).not.toContain('KYC');
    expect(out).not.toContain('address');
  });
});

describe('a list of results', () => {
  const row = (label: string) => ({ id: label, label, values: {} });

  it('says how many matched, not just how many are shown', () => {
    const out = list([row('A'), row('B')], 37, (r) => r.label, 'none');
    expect(out).toContain('37 matches');
    expect(out).toContain('(37 match in total; showing the first 2.)');
  });

  it('says nothing matched in words, not as an empty list', () => {
    expect(list([], 0, (r) => r.label, 'No leads match that.')).toBe('No leads match that.');
  });
});
