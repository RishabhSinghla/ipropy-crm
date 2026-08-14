import { describe, expect, it, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../../src/db/pool.js', () => ({ db: { query: (...args: unknown[]) => query(...args) } }));

const { comparablesFor } = await import('../../src/ai/comparables.js');

const unit = (price: number, days: number | null = null) => ({
  price, status: days === null ? 'Available' : 'Sold', days_listed: days,
});

beforeEach(() => query.mockReset());

describe('comparables', () => {
  it('says nothing without a locality and a configuration', async () => {
    // Half a shape is not a comparison, and asking the database for one is a
    // query that can only return noise.
    expect(await comparablesFor({ locality: null, configuration: '3 BHK', carpetArea: null })).toBeNull();
    expect(await comparablesFor({ locality: 'Powai', configuration: null, carpetArea: null })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('stays silent below five comparable units', async () => {
    // Four units is not a market. A median drawn from them is a number with
    // false authority, and somebody will price against it.
    query.mockResolvedValue({ rows: [unit(1e7), unit(1.1e7), unit(1.2e7), unit(1.3e7)] });
    expect(await comparablesFor({ locality: 'Powai', configuration: '3 BHK', carpetArea: null })).toBeNull();
  });

  it('reports a range and a typical price once there are enough', async () => {
    query.mockResolvedValue({
      rows: [unit(2.0e7), unit(2.1e7), unit(2.2e7), unit(2.3e7), unit(2.4e7), unit(2.5e7)],
    });
    const result = await comparablesFor({ locality: 'Powai', configuration: '3 BHK', carpetArea: null });
    expect(result).not.toBeNull();
    expect(result!.count).toBe(6);
    expect(result!.summary).toContain('Your last 6 3 BHKs in Powai');
    expect(result!.summary).toContain('₹2.2 Cr');
  });

  it('mentions how long they took only when enough of them actually sold', async () => {
    query.mockResolvedValue({
      rows: [unit(2e7, 30), unit(2.1e7, 45), unit(2.2e7, 60), unit(2.3e7), unit(2.4e7), unit(2.5e7)],
    });
    const withDays = await comparablesFor({ locality: 'Powai', configuration: '3 BHK', carpetArea: null });
    expect(withDays!.summary).toContain('took about 45 days');

    query.mockResolvedValue({
      rows: [unit(2e7, 30), unit(2.1e7), unit(2.2e7), unit(2.3e7), unit(2.4e7), unit(2.5e7)],
    });
    const withoutDays = await comparablesFor({ locality: 'Powai', configuration: '3 BHK', carpetArea: null });
    expect(withoutDays!.summary).not.toContain('days');
    expect(withoutDays!.medianDaysToSell).toBeNull();
  });

  it('never recommends a price', async () => {
    // The person typing knows the floor, the view and how badly the builder
    // needs the money. Stating a number to charge would be pretending otherwise.
    query.mockResolvedValue({ rows: Array.from({ length: 8 }, (_, i) => unit(2e7 + i * 1e6)) });
    const result = await comparablesFor({ locality: 'Powai', configuration: '3 BHK', carpetArea: null });
    expect(result!.summary).not.toMatch(/should|recommend|price it/i);
  });
});
