/**
 * The number a WhatsApp message is actually sent to.
 *
 * **Every free-text reply this CRM ever attempted failed on this**, and the
 * error said something else entirely. `ipy_conversation.handle` is the last
 * ten digits — a matching key, so a contact is found whether their mobile is
 * stored as `9891222206`, `+919891222206` or `0 9891 222206` — and it was also
 * being handed to the provider as the destination. WhatsApp read ten digits as
 * a different person from the `919891222206` who had just written in, found no
 * session for them, and refused with *"Sending message outside 24 hour window
 * is not allowed."* Which reads exactly like a window bug, and is not one.
 *
 * Read off production on 20 September 2026: the window was open until the next
 * morning, and the send was refused anyway.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const row = vi.hoisted(() => ({ value: null as Record<string, string | null> | null }));

vi.mock('../src/db/pool.js', () => ({
  db: { queryOne: vi.fn(async () => row.value), query: vi.fn(async () => ({ rows: [] })) },
  onCommit: vi.fn(), transaction: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/core/events/bus.js', () => ({ bus: { emit: vi.fn() } }));
vi.mock('../src/integrations/whatsapp/business/registry.js', () => ({ activeBusinessProvider: () => null }));
vi.mock('../src/integrations/whatsapp/business/media.js', () => ({ prepareOutgoingMedia: vi.fn() }));

const { dialableNumber } = await import('../src/integrations/whatsapp/business/send.js');

beforeEach(() => { row.value = null; });

describe('which number a message goes to', () => {
  it('prefers what WhatsApp itself called them', async () => {
    // The only authoritative source: it is the number WhatsApp used.
    expect(await dialableNumber('919891222206', '9891222206', 'rec-1')).toBe('919891222206');
  });

  it('never sends to the ten-digit matching key', async () => {
    // The bug itself. With no wa_id and no record, there is no country code
    // anywhere, and a ten-digit destination must not go out.
    expect(await dialableNumber(null, '9891222206', null)).toBeNull();
  });

  it('takes a number that already carries its country code', async () => {
    expect(await dialableNumber(null, '+91 98912 22206', null)).toBe('919891222206');
  });

  it('puts the record\'s country code back on its national number', async () => {
    row.value = { country_code: '91', mobile: '9891222206' };
    expect(await dialableNumber(null, '9891222206', 'rec-1')).toBe('919891222206');
  });

  it('refuses rather than assuming +91', async () => {
    /*
      The reason this returns null instead of guessing: a silent Indian
      default sends an NRI buyer's message to a stranger in India, and the
      number is unrecoverable once it has gone.
    */
    row.value = { country_code: null, mobile: '9891222206' };
    expect(await dialableNumber(null, '9891222206', 'rec-1')).toBeNull();
  });

  it('does not double a country code the number already has', async () => {
    row.value = { country_code: '91', mobile: '919891222206' };
    expect(await dialableNumber(null, '919891222206', 'rec-1')).toBe('919891222206');
  });
});
