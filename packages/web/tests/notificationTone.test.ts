import { expect, it } from 'vitest';
import { notificationTone } from '../src/lib/notificationTone';
it('groups notifications by type, independently of read state', () => {
  expect(notificationTone('mention', null)).toContain('bg-sky-50');
  expect(notificationTone('integration_failure', null)).toContain('bg-red-50');
  expect(notificationTone('ai', null)).toContain('bg-violet-50');
  expect(notificationTone('import', null)).toContain('bg-amber-50');
  expect(notificationTone('system', '/capture/123')).toContain('bg-emerald-50');
});
