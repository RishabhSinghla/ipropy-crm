/**
 * The one decision the WhatsApp composer makes.
 *
 * A message box offered when WhatsApp will not carry a free message is a rep
 * typing a paragraph that fails on send, with a provider's rejection code as
 * the only explanation. Both halves have to hold: the window, and what the
 * live provider can do at all.
 */
import { describe, expect, it } from 'vitest';
import { composerMode, readMessageMedia, whyNoTextBox } from '../src/lib/whatsapp';

describe('what the composer offers', () => {
  it('offers a message box only inside the 24-hour window', () => {
    expect(composerMode(['text', 'templates'], true)).toBe('text');
    expect(composerMode(['text', 'templates'], false)).toBe('template');
  });

  it('never offers a box on a provider that sends templates only', () => {
    // AiSensy's campaign API, which is the whole reason this is not just a
    // window check.
    expect(composerMode(['templates'], true)).toBe('template');
    expect(composerMode(['templates'], false)).toBe('template');
  });

  it('says which of the two reasons applies', () => {
    expect(whyNoTextBox(['text'], 'Meta Cloud API')).toMatch(/24 hours/);
    expect(whyNoTextBox(['templates'], 'AiSensy')).toBe('AiSensy sends approved templates only.');
    expect(whyNoTextBox(['templates'], null)).toMatch(/^This provider/);
  });
});

describe('the file inside a message', () => {
  it('renders only what the CRM actually holds', () => {
    expect(readMessageMedia({ attachmentId: 'abc', fileName: 'plan.pdf' })).toMatchObject({
      attachmentId: 'abc',
    });
  });

  it('shows nothing for a message that still only names the vendor\'s copy', () => {
    /*
      The failure this prevents is the quiet one. A row from before the CRM
      collected its own copy — or one whose collection failed — carries the
      provider's id and nothing else. Rendering that is a link that works today
      and is a broken square a year from now, when nobody can reconstruct why.
    */
    expect(readMessageMedia({ id: 'vendor-id', mimeType: 'image/jpeg' })).toBeNull();
    expect(readMessageMedia(null)).toBeNull();
    expect(readMessageMedia('not an object')).toBeNull();
    expect(readMessageMedia(undefined)).toBeNull();
  });
});
