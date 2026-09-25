/**
 * Leaving the unsubscribe note in WhatsMarketing.
 *
 * Their API has no subscribe switch, so a note is what the CRM writes. These
 * pin the three things that matter: the number goes with its country code
 * (their API reads ten digits as somebody else), the note says plainly what
 * happened and who did it, and a vendor that is down never throws into the
 * unsubscribe it is reporting on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ name: 'whatsapp_whatsmarketing' as string | null }));
const notes = vi.hoisted(() => ({ calls: [] as { phone: string; note: string }[], fail: false }));

vi.mock('../src/integrations/whatsapp/business/registry.js', () => ({
  activeBusinessProvider: () => (provider.name ? { name: provider.name } : null),
}));
vi.mock('../src/integrations/whatsapp/business/whatsMarketing.js', () => ({
  WHATSMARKETING_PROVIDER: 'whatsapp_whatsmarketing',
  addWhatsMarketingNote: vi.fn(async (phone: string, note: string) => {
    if (notes.fail) throw new Error('whatsmarketing.in refused that (HTTP 500)');
    notes.calls.push({ phone, note });
  }),
}));
vi.mock('../src/integrations/whatsapp/business/send.js', () => ({ defaultCountryCode: async () => '91' }));
vi.mock('../src/utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const { tellWhatsMarketingAboutConsent } = await import('../src/integrations/whatsapp/business/consentSync.js');

beforeEach(() => { notes.calls = []; notes.fail = false; provider.name = 'whatsapp_whatsmarketing'; });

describe('the unsubscribe note in WhatsMarketing', () => {
  it('writes to the number with its country code, saying what happened and who did it', async () => {
    expect(await tellWhatsMarketingAboutConsent({ handle: '9891222206', subscribed: false, byWhom: 'Priya Sharma' })).toBe(true);
    expect(notes.calls).toHaveLength(1);
    expect(notes.calls[0].phone).toBe('919891222206');
    expect(notes.calls[0].note).toMatch(/UNSUBSCRIBED from WhatsApp on .+ by Priya Sharma\. Do not message/);
  });

  it('keeps a number that already has its country code as it is', async () => {
    await tellWhatsMarketingAboutConsent({ handle: '919891222206', subscribed: true, byWhom: 'the customer' });
    expect(notes.calls[0]).toMatchObject({ phone: '919891222206' });
    expect(notes.calls[0].note).toMatch(/subscribed to WhatsApp again/);
  });

  it('does nothing when another provider is the live one', async () => {
    provider.name = 'whatsapp_meta';
    expect(await tellWhatsMarketingAboutConsent({ handle: '9891222206', subscribed: false, byWhom: 'x' })).toBe(false);
    expect(notes.calls).toHaveLength(0);
  });

  it('never throws when WhatsMarketing is down — the CRM unsubscribe already stands', async () => {
    notes.fail = true;
    await expect(tellWhatsMarketingAboutConsent({ handle: '9891222206', subscribed: false, byWhom: 'x' })).resolves.toBe(false);
  });
});
