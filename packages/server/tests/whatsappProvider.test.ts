/**
 * The contract every WhatsApp connection answers to.
 *
 * The point of the abstraction is that a caller never has to know which one it
 * is holding — so what is pinned here is the *refusal*. A provider asked for
 * something it cannot do must say so loudly and by name; a send that quietly
 * does nothing is the failure this file exists to prevent, and it is how 40,000
 * birthday messages came to sit in a queue nobody looked at.
 */
import { describe, expect, it } from 'vitest';
import {
  NotSupportedError, requireCapability,
  type WhatsAppCapability, type WhatsAppProvider,
} from '../src/integrations/whatsapp/providers/types.js';

function providerWith(name: string, capabilities: WhatsAppCapability[]): WhatsAppProvider {
  return { name, capabilities: new Set(capabilities) } as WhatsAppProvider;
}

describe('a WhatsApp provider', () => {
  it('lets through what it can do', () => {
    const cloud = providerWith('cloud', ['text', 'templates']);
    expect(() => requireCapability(cloud, 'text')).not.toThrow();
  });

  it('refuses what it cannot, by name, rather than failing silently', () => {
    const web = providerWith('web', ['text', 'media', 'perAgentAccounts']);
    expect(() => requireCapability(web, 'templates')).toThrow(NotSupportedError);
    try {
      requireCapability(web, 'templates');
    } catch (err) {
      expect((err as NotSupportedError).provider).toBe('web');
      expect((err as NotSupportedError).capability).toBe('templates');
      // The message is read by a person, so it names both halves.
      expect((err as Error).message).toContain('web');
      expect((err as Error).message).toContain('templates');
    }
  });

  it('is its own error type, so "cannot" is not confused with "broken"', () => {
    const cloud = providerWith('cloud', ['text']);
    let caught: unknown;
    try { requireCapability(cloud, 'perAgentAccounts'); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(NotSupportedError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('NotSupportedError');
  });

  it('keeps the two connections genuinely different', () => {
    /*
      The whole reason for the abstraction: Meta's Cloud API sends templates
      from one business number, a linked device sends anything from a person's
      own number. Neither is a superset of the other, and code that assumes
      one of them is has to be rewritten when the business changes provider.
    */
    const cloud = providerWith('cloud', ['text', 'media', 'templates', 'markRead', 'messageStatus']);
    const web = providerWith('web', ['text', 'media', 'location', 'markRead', 'historySync', 'perAgentAccounts']);

    expect(cloud.capabilities.has('perAgentAccounts')).toBe(false);
    expect(web.capabilities.has('templates')).toBe(false);
    expect(cloud.capabilities.has('text') && web.capabilities.has('text')).toBe(true);
  });
});
