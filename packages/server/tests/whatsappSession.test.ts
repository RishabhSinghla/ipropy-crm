/**
 * Reading a WhatsApp message, and the shapes it arrives in.
 *
 * `textOf` is small and is the one part of the socket layer that can be tested
 * without a socket — and it is worth testing, because a caption on an image is
 * a different field from the text of a reply, which is different again from a
 * plain message. Missing one means a conversation in the CRM with a blank line
 * where the customer's question was.
 */
import { describe, expect, it } from 'vitest';
import { textOf } from '../src/integrations/whatsapp/agent/session.js';

const message = (inner: unknown) => ({ message: inner } as never);

describe('the readable text of a message', () => {
  it('reads a plain message', () => {
    expect(textOf(message({ conversation: 'Looking for 3 BHK in Greenfields.' })))
      .toBe('Looking for 3 BHK in Greenfields.');
  });

  it('reads a reply, which WhatsApp wraps differently', () => {
    expect(textOf(message({ extendedTextMessage: { text: 'Around ₹1.60 Cr.' } })))
      .toBe('Around ₹1.60 Cr.');
  });

  it('reads the caption on a picture, a video and a document', () => {
    expect(textOf(message({ imageMessage: { caption: 'Front elevation' } }))).toBe('Front elevation');
    expect(textOf(message({ videoMessage: { caption: 'Walkthrough' } }))).toBe('Walkthrough');
    expect(textOf(message({ documentMessage: { caption: 'Brochure' } }))).toBe('Brochure');
  });

  it('says nothing rather than guessing, when there is no text', () => {
    // A voice note has no text at all. The conversation should show it as a
    // voice note, which is the caller's job — inventing a line here would put
    // words in a customer's mouth.
    expect(textOf(message({ audioMessage: { seconds: 7 } }))).toBeNull();
    expect(textOf(message(null))).toBeNull();
    expect(textOf({} as never)).toBeNull();
  });

  it('prefers the plain body over a caption when both somehow exist', () => {
    expect(textOf(message({ conversation: 'first', imageMessage: { caption: 'second' } })))
      .toBe('first');
  });
});
