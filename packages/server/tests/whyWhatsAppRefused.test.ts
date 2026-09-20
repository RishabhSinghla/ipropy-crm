/**
 * A refused message has to say something a rep can do something about.
 *
 * The owner met `(Error Code : 131049 )In order to maintain a healthy
 * ecosystem engagement, the message failed to be delivered.` on a red bubble
 * on 20 September 2026. It reads like a fault in the CRM; it is Meta limiting
 * how many marketing messages one person may receive, and nothing here can
 * lift it.
 */
import { describe, expect, it } from 'vitest';
import { whyItFailed } from '../src/integrations/whatsapp/business/whyItFailed.js';

describe('why a WhatsApp message was refused', () => {
  it('explains the one the owner actually saw', () => {
    const raw = '(Error Code : 131049 )In order to maintain a healthy ecosystem '
      + 'engagement, the message failed to be delivered.';
    const said = whyItFailed(raw);
    expect(said).toMatch(/limits how many marketing messages/);
    // The provider's own sentence is kept, never replaced: it is what a
    // support conversation with the vendor is about.
    expect(said).toContain(raw);
  });

  it('leaves a code it does not know completely alone', () => {
    // Guessing at an unknown code sends somebody to fix the wrong thing.
    const raw = '(Error Code : 999999 ) Something nobody has seen before.';
    expect(whyItFailed(raw)).toBe(raw);
  });

  it('does not touch an error that carries no code', () => {
    const raw = 'Sending message outside 24 hour window is not allowed.';
    expect(whyItFailed(raw)).toBe(raw);
  });
});
