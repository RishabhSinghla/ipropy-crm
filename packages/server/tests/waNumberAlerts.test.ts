import { describe, expect, it } from 'vitest';
import { decideNumberAlerts, decideServiceAlert, GRACE_MS, REMINDER_MS, type WatchedNumber } from '../src/integrations/whatsapp/business/numberAlerts.js';

const now = new Date('2026-11-01T12:00:00Z');
const ago = (ms: number): Date => new Date(now.getTime() - ms);
const num = (over: Partial<WatchedNumber>): WatchedNumber => ({ id: 'n1', name: 'Test line', status: 'ready', statusSince: ago(10 * GRACE_MS), alertedAt: null, ...over });

describe('number alerts', () => {
  it('stays quiet for a healthy number', () => {
    expect(decideNumberAlerts([num({})], now)).toEqual({ alert: [], recover: [] });
  });
  it('ignores a blip shorter than the grace period', () => {
    expect(decideNumberAlerts([num({ status: 'disconnected', statusSince: ago(GRACE_MS - 1000) })], now).alert).toHaveLength(0);
  });
  it('alerts once a disconnect has lasted past the grace period', () => {
    expect(decideNumberAlerts([num({ status: 'disconnected', statusSince: ago(GRACE_MS + 1000) })], now).alert).toHaveLength(1);
    expect(decideNumberAlerts([num({ status: 'qr_ready', statusSince: ago(GRACE_MS + 1000) })], now).alert).toHaveLength(1);
  });
  it('does not alert again while the same outage is already alerted', () => {
    const n = num({ status: 'disconnected', statusSince: ago(3_600_000), alertedAt: ago(60_000) });
    expect(decideNumberAlerts([n], now)).toEqual({ alert: [], recover: [] });
  });
  it('reminds once after a day', () => {
    const n = num({ status: 'disconnected', statusSince: ago(2 * REMINDER_MS), alertedAt: ago(REMINDER_MS + 1000) });
    expect(decideNumberAlerts([n], now).alert).toHaveLength(1);
  });
  it('sends a recovery only for a number that had been alerted', () => {
    expect(decideNumberAlerts([num({ alertedAt: ago(60_000) })], now).recover).toHaveLength(1);
    expect(decideNumberAlerts([num({})], now).recover).toHaveLength(0);
  });
  it('treats an unknown status as no news', () => {
    expect(decideNumberAlerts([num({ status: 'unknown', statusSince: ago(10 * GRACE_MS) })], now).alert).toHaveLength(0);
  });
});

describe('service alerts', () => {
  it('waits out the grace period, alerts once, reminds after a day, and says when it is back', () => {
    const first = decideServiceAlert(false, { downSince: null, alertedAt: null }, now);
    expect(first.send).toBeNull();
    const later = new Date(now.getTime() + GRACE_MS + 1000);
    const second = decideServiceAlert(false, first.next, later);
    expect(second.send).toBe('down');
    expect(decideServiceAlert(false, second.next, new Date(later.getTime() + 60_000)).send).toBeNull();
    expect(decideServiceAlert(false, second.next, new Date(later.getTime() + REMINDER_MS + 1)).send).toBe('down');
    const back = decideServiceAlert(true, second.next, new Date(later.getTime() + 120_000));
    expect(back.send).toBe('back');
    expect(back.next).toEqual({ downSince: null, alertedAt: null });
  });
  it('says nothing when it was never down long enough to alert', () => {
    const first = decideServiceAlert(false, { downSince: null, alertedAt: null }, now);
    expect(decideServiceAlert(true, first.next, new Date(now.getTime() + 30_000)).send).toBeNull();
  });
});
