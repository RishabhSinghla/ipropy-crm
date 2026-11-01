import { describe, expect, it } from 'vitest';
import { rowChip } from '../src/lib/whatsapp';

const now = new Date('2026-11-01T10:00:00Z');
const base = { lastDirection: 'outbound', lastStatus: 'sent', unreadCount: 0, assignedName: 'Asha', windowExpiresAt: '2026-11-02T07:00:00Z' };

describe('rowChip', () => {
  it('plain: shows the window left', () => {
    expect(rowChip(base, false, now)?.text).toBe('Reply window open · 21h left');
  });
  it('plain: closed window', () => {
    expect(rowChip({ ...base, windowExpiresAt: null }, false, now)?.text).toBe('Reply window closed');
  });
  it('plain: unassigned customer message needs a reply', () => {
    expect(rowChip({ ...base, lastDirection: 'inbound', assignedName: null }, false, now)?.text).toBe('Needs a reply · unassigned');
  });
  it('failed beats everything', () => {
    expect(rowChip({ ...base, lastStatus: 'failed' }, false, now)?.tone).toBe('red');
    expect(rowChip({ ...base, lastStatus: 'failed' }, true, now)?.text).toBe('Failed');
  });
  it('api: delivery states and replies', () => {
    expect(rowChip({ ...base, lastStatus: 'read' }, true, now)?.text).toBe('Read');
    expect(rowChip({ ...base, lastStatus: 'delivered' }, true, now)?.text).toBe('Delivered');
    expect(rowChip(base, true, now)?.text).toBe('Sent');
    expect(rowChip({ ...base, lastDirection: 'inbound' }, true, now)?.text).toBe('Replied · needs a person');
  });
});
