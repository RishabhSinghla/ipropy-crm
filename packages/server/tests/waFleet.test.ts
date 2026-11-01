import { describe, expect, it } from 'vitest';
import {
  MAX_RESTART_ATTEMPTS, readCapacity, roomToStart, rssFromMetrics, watchdogDecision,
} from '../src/integrations/whatsapp/business/waFleet.js';
import { decideSend, DEFAULT_LIMITS, inQuietHours } from '../src/integrations/whatsapp/business/openwaGuards.js';

const now = new Date('2026-11-01T10:00:00Z');
const dropped = { status: 'disconnected', wantedRunning: true, hasPhone: true, attempts: 0, nextRestartAt: null, now };

describe('capacity', () => {
  it('refuses a number beyond the plan, in plain words', () => {
    const v = roomToStart({ capacity: { maxLive: 3, memoryLimitMb: 512 }, liveCount: 3, alreadyLive: false, rssMb: null });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/bigger Render plan/);
  });
  it('lets a number that is already connected restart', () => {
    expect(roomToStart({ capacity: { maxLive: 3, memoryLimitMb: 512 }, liveCount: 3, alreadyLive: true, rssMb: 900 }).ok).toBe(true);
  });
  it('refuses when memory is above 80 percent even if the count allows it', () => {
    expect(roomToStart({ capacity: { maxLive: 10, memoryLimitMb: 512 }, liveCount: 2, alreadyLive: false, rssMb: 430 }).ok).toBe(false);
    expect(roomToStart({ capacity: { maxLive: 10, memoryLimitMb: 512 }, liveCount: 2, alreadyLive: false, rssMb: 300 }).ok).toBe(true);
  });
  it('clamps nonsense settings', () => {
    expect(readCapacity({ maxLive: 'x' }).maxLive).toBe(3);
    expect(readCapacity({ maxLive: 9999, memoryLimitMb: 1 })).toEqual({ maxLive: 40, memoryLimitMb: 256 });
    expect(readCapacity(null)).toEqual({ maxLive: 3, memoryLimitMb: 512 });
  });
  it('reads memory from the metrics text', () => {
    expect(rssFromMetrics('# TYPE x gauge\nopenwa_process_resident_memory_bytes 234881024\n')).toBe(234881024);
    expect(rssFromMetrics('nothing here')).toBeNull();
  });
});

describe('watchdog', () => {
  it('restarts a dropped number that was linked', () => {
    expect(watchdogDecision(dropped)).toBe('restart');
  });
  it('leaves a deliberately stopped number alone', () => {
    expect(watchdogDecision({ ...dropped, wantedRunning: false })).toBe('none');
  });
  it('leaves a never-linked number alone (it needs a QR scan, not a restart)', () => {
    expect(watchdogDecision({ ...dropped, hasPhone: false })).toBe('none');
    expect(watchdogDecision({ ...dropped, status: 'qr_ready' })).toBe('none');
  });
  it('waits for the backoff', () => {
    expect(watchdogDecision({ ...dropped, nextRestartAt: new Date(now.getTime() + 60_000) })).toBe('none');
    expect(watchdogDecision({ ...dropped, nextRestartAt: new Date(now.getTime() - 1) })).toBe('restart');
  });
  it('stops after the maximum attempts and never loops', () => {
    expect(watchdogDecision({ ...dropped, attempts: MAX_RESTART_ATTEMPTS })).toBe('give_up');
  });
  it('does nothing for a healthy number', () => {
    expect(watchdogDecision({ ...dropped, status: 'ready' })).toBe('none');
  });
});

describe('quiet hours', () => {
  it('wraps midnight', () => {
    expect(inQuietHours(21, 8, 23)).toBe(true);
    expect(inQuietHours(21, 8, 3)).toBe(true);
    expect(inQuietHours(21, 8, 8)).toBe(false);
    expect(inQuietHours(21, 8, 14)).toBe(false);
  });
  it('is off when unset or equal', () => {
    expect(inQuietHours(null, null, 2)).toBe(false);
    expect(inQuietHours(5, 5, 5)).toBe(false);
  });
  it('blocks a send inside the window and allows it outside', () => {
    const limits = { ...DEFAULT_LIMITS, quietFrom: 21, quietTo: 8 };
    const counts = { userToday: 0, numberToday: 0, secondsSinceLast: null };
    const at = (localHour: number) => decideSend(limits, { ...counts, localHour });
    expect(at(22)).toMatchObject({ ok: false, code: 'QUIET_HOURS' });
    expect(at(10)).toEqual({ ok: true });
  });
});
