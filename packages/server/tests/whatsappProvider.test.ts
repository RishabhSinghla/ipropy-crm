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

/*
  A provider that implements a thing must say so, or the screen refuses it.

  Meta's `listTemplates` reads `GET /{waba-id}/message_templates` — the reason
  the setup guide asks for a WABA id at all — and Gupshup's reads their own
  list. Neither declared `templateSync`, so Admin → WhatsApp Templates answered
  the Sync button with *"whatsapp_meta does not hand its template list back"*,
  which is simply untrue. Found by pressing the button on 20 September 2026:
  nothing had ever pressed it, because no provider had ever been connected.
*/
describe('a capability is a promise the adapter actually keeps', () => {
  it('Meta and Gupshup both say they can fetch a template list', async () => {
    const { metaCloudProvider } = await import('../src/integrations/whatsapp/business/metaCloud.js');
    const { gupshupProvider } = await import('../src/integrations/whatsapp/business/resellers.js');
    expect(metaCloudProvider.capabilities.has('templateSync')).toBe(true);
    expect(gupshupProvider.capabilities.has('templateSync')).toBe(true);
  });

  it('AiSensy still says it cannot, because it publishes no list', async () => {
    const { aisensyProvider } = await import('../src/integrations/whatsapp/business/resellers.js');
    expect(aisensyProvider.capabilities.has('templateSync')).toBe(false);
  });
});
