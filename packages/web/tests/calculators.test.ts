import { describe, expect, it } from 'vitest';
import { calculateFloor, calculateLoan, defaultCharges } from '../src/lib/calculators';
import { calculationPdf } from '../src/lib/calculatorPdf';

describe('loan calculation', () => {
  it('calculates reducing balance and pays off exactly', () => {
    const result = calculateLoan(1000000, 8.5, 240);
    expect(result.emi).toBe(8678.23);
    expect(result.schedule).toHaveLength(240);
    expect(result.schedule[0].interest).toBe(7083.33);
    expect(result.schedule.at(-1)!.balance).toBe(0);
    expect(result.schedule.reduce((sum, row) => sum + row.principal, 0)).toBeCloseTo(1000000, 2);
    expect(result.schedule.reduce((sum, row) => sum + row.emi, 0)).toBeCloseTo(result.totalPayment, 2);
    for (let index = 1; index < result.schedule.length; index += 1) expect(result.schedule[index].opening).toBe(result.schedule[index - 1].balance);
  });
  it('supports zero interest and adjusts the last instalment', () => {
    const result = calculateLoan(100, 0, 3);
    expect(result.schedule.map((row) => row.emi)).toEqual([33.33, 33.33, 33.34]);
    expect(result.totalInterest).toBe(0);
    expect(result.totalPayment).toBe(100);
  });
  it('rejects invalid inputs', () => {
    for (const values of [[0, 8, 12], [NaN, 8, 12], [100, -1, 12], [100, Infinity, 12], [100, 8, 1.5], [100, 8, 601], [1e13, 8, 12]]) expect(() => calculateLoan(...values as [number, number, number])).toThrow();
  });
});
describe('builder floor charges', () => {
  it('matches the supplied sheet using exact calculation area', () => {
    const result = calculateFloor({ flatCost: 0, area: 1612.5, registryValue: 11500000, stampRate: 6, feeBase: 10000000, feeRate: 0.5, charges: defaultCharges() });
    expect(result.groups).toEqual({ 'Water, sewer & mutation': 119284, Electricity: 78000, Registration: 752000 });
    expect(result.additional).toBe(949284);
  });
  it('includes flat cost and custom charges', () => {
    const result = calculateFloor({ flatCost: 5000000, area: 1000, registryValue: 0, stampRate: 0, feeBase: 0, feeRate: 0, charges: [{ id: 'extra', label: 'Extra', group: 'Other', rate: 1000, quantity: 2, gst: 18 }] });
    expect(result.total).toBe(5002360);
  });
  it('rejects missing inputs', () => {
    expect(() => calculateFloor({ flatCost: NaN, area: 0, registryValue: 0, stampRate: 0, feeBase: 0, feeRate: 0, charges: [] })).toThrow();
  });
});
describe('offline PDF report', () => {
  it('paginates the entire sheet and escapes text safely', () => {
    const text = new TextDecoder().decode(calculationPdf(['Client (sample) \\', ...Array.from({ length: 240 }, (_, index) => `Month ${index + 1}`)]));
    expect(text).toContain('/Count 6');
    expect(text).toContain('Month 240');
    expect(text).toContain('Client \\(sample\\) \\\\');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    const xref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
  });
  it('routes non-Latin reports to browser PDF without losing names', () => {
    expect(() => calculationPdf(['नाम'])).toThrow(/Print/);
  });
});
