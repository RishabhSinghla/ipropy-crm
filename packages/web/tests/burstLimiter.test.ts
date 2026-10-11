import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { limitBursts } from '../src/lib/burstLimiter';

describe('limitBursts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refreshes the first edit at once', () => {
    const refresh = vi.fn();
    limitBursts(refresh, 5000)('leads', 'a');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('leads', 'a');
  });

  it('folds a burst into one more refresh when the window ends', () => {
    const refresh = vi.fn();
    const edited = limitBursts(refresh, 5000);
    edited('leads', 'a');
    for (let i = 0; i < 20; i += 1) edited('leads', `r${i}`);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
    // Many records changed, so the whole module is refreshed rather than one record.
    expect(refresh).toHaveBeenLastCalledWith('leads', undefined);
  });

  it('refreshes the one record that changed, when only one did', () => {
    const refresh = vi.fn();
    const edited = limitBursts(refresh, 5000);
    edited('leads', 'a');
    edited('leads', 'b');
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenLastCalledWith('leads', 'b');
  });

  it('keeps modules apart', () => {
    const refresh = vi.fn();
    const edited = limitBursts(refresh, 5000);
    edited('leads', 'a');
    edited('properties', 'b');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('goes quiet when nothing more arrives, and the next edit is immediate again', () => {
    const refresh = vi.fn();
    const edited = limitBursts(refresh, 5000);
    edited('leads', 'a');
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    edited('leads', 'b');
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
