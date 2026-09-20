import { describe, expect, it } from 'vitest';
import { blockingSteps, phoneChecklist, stepIsDone } from '../src/lib/phonePermissions';
import type { CallSyncStatus } from '../src/lib/callSync';

const status = (over: Partial<CallSyncStatus> = {}): CallSyncStatus => ({
  available: true,
  paired: false,
  callLogGranted: false,
  callPhoneGranted: false,
  locationGranted: false,
  backgroundLocationGranted: false,
  lastSyncAt: 0,
  lastSyncSummary: null,
  locationEnabled: false,
  uploadRecordings: false,
  version: '2.1.0',
  ...over,
});

describe('what the phone still has to allow', () => {
  it('a fresh install has everything to do', () => {
    const todo = blockingSteps({ status: status(), alerts: 'default' });
    expect(todo).toEqual(['pair', 'callPhone', 'callLog']);
  });

  it('nothing blocks a call once both call permissions are allowed', () => {
    const input = {
      status: status({ paired: true, callPhoneGranted: true, callLogGranted: true }),
      alerts: 'denied' as const,
    };
    expect(blockingSteps(input)).toEqual([]);
  });

  it('notifications are worth having and never block a call', () => {
    const input = {
      status: status({ paired: true, callPhoneGranted: true, callLogGranted: true }),
      alerts: 'default' as const,
    };
    expect(blockingSteps(input)).toEqual([]);
    expect(phoneChecklist(input).find((n) => n.key === 'alerts')?.done).toBe(false);
  });

  it('location is not asked for until somebody switches it on', () => {
    const off = { status: status({ paired: true }), alerts: 'granted' as const };
    expect(phoneChecklist(off).map((n) => n.key)).not.toContain('location');

    const on = { status: status({ paired: true, locationEnabled: true }), alerts: 'granted' as const };
    expect(phoneChecklist(on).map((n) => n.key)).toContain('location');
  });

  it('"while using the app" is not location granted', () => {
    // Foreground-only reports nothing once the screen goes off, which is a map
    // that quietly stops moving rather than one that says it is off.
    const input = {
      status: status({ paired: true, locationEnabled: true, locationGranted: true }),
      alerts: 'granted' as const,
    };
    expect(stepIsDone('location', input)).toBe(false);
  });

  it('with no plugin at all, nothing reads as done', () => {
    const input = { status: null, alerts: 'unavailable' as const };
    expect(phoneChecklist(input).every((n) => !n.done)).toBe(true);
  });
});
