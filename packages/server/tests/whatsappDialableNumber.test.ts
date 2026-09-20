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
/** The organisation's default, read from `ipy_setting` by its own query. */
const orgCode = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('../src/db/pool.js', () => ({
  db: {
    queryOne: vi.fn(async (sql: string) => (sql.includes('ipy_setting')
      ? (orgCode.value === null ? null : { value: orgCode.value })
      : row.value)),
    query: vi.fn(async () => ({ rows: [] })),
  },
  onCommit: vi.fn(), transaction: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/core/events/bus.js', () => ({ bus: { emit: vi.fn() } }));
vi.mock('../src/integrations/whatsapp/business/registry.js', () => ({ activeBusinessProvider: () => null }));
vi.mock('../src/integrations/whatsapp/business/media.js', () => ({ prepareOutgoingMedia: vi.fn() }));

const { dialableNumber } = await import('../src/integrations/whatsapp/business/send.js');

beforeEach(() => { row.value = null; orgCode.value = null; });

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

  it("falls back to the organisation's own default, which is a row somebody can see", async () => {
    /*
      The other end of the refusal, met on 20 September: most of this database
      was imported with a ten-digit mobile and no `country_code`, so every one
      of those contacts was unreachable — the composer refused before the
      provider was called. What the warning is about is a default **nobody can
      see**; `org.country_code` has a label in Admin → Settings.
    */
    row.value = { country_code: null, mobile: '9311171162' };
    orgCode.value = '91';
    expect(await dialableNumber(null, '9311171162', 'rec-1')).toBe('919311171162');
  });

  it("lets the contact's own code win over the organisation's", async () => {
    // An NRI buyer whose record says 971 must not be sent to India because a
    // setting says 91. The record is the more specific fact and it wins.
    row.value = { country_code: '971', mobile: '501234567' };
    orgCode.value = '91';
    expect(await dialableNumber(null, '501234567', 'rec-1')).toBe('971501234567');
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
