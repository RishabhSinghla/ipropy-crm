import { describe, expect, it } from 'vitest';
import { notificationTone } from '../src/lib/notificationTone';
it('groups notifications by type, independently of read state', () => {
  expect(notificationTone('mention', null)).toContain('bg-sky-50');
  expect(notificationTone('integration_failure', null)).toContain('bg-red-50');
  expect(notificationTone('ai', null)).toContain('bg-violet-50');
  expect(notificationTone('import', null)).toContain('bg-amber-50');
  expect(notificationTone('system', '/capture/123')).toContain('bg-emerald-50');
});

describe('a notification that has been read', () => {
  it('is plain white whatever kind it is', () => {
    for (const kind of ['ai', 'mention', 'task', 'matches', 'escalation', 'birthday', 'something_else']) {
      const tone = notificationTone(kind, null, true);
      expect(tone).toContain('bg-white');
      expect(tone).not.toMatch(/emerald|violet|sky|amber|red-|pink|brand-/);
    }
  });

  it('keeps its colour while unread', () => {
    expect(notificationTone('mention', null, false)).toContain('sky');
    expect(notificationTone('mention', null)).toContain('sky');
  });
});
