/**
 * Which official provider is switched on, and what it can do.
 *
 * One card active at a time: two live business connections on one WhatsApp
 * number is two systems answering the same customer, and the second reply
 * lands seconds after the first with no way to tell which one a rep saw.
 *
 * Everything else in the CRM asks here rather than importing a vendor, which
 * is the whole point of the layer — moving from AiSensy to Gupshup is an admin
 * switching a card, and no conversation moves anywhere.
 */
import {
  firstActiveIntegration, getIntegrationCredentials,
} from '../../../core/settings/integrations.js';
import { metaCloudProvider, META_PROVIDER } from './metaCloud.js';
import {
  aisensyProvider, AISENSY_PROVIDER, gupshupProvider, GUPSHUP_PROVIDER,
  whatsMarketingProvider, WHATSMARKETING_PROVIDER,
} from './resellers.js';
import type { WhatsAppBusinessProvider } from './types.js';

/** In the order an admin sees them, which is also the order a tie is broken. */
export const BUSINESS_PROVIDERS: { id: string; label: string; provider: WhatsAppBusinessProvider }[] = [
  { id: META_PROVIDER, label: 'Meta Cloud API (direct)', provider: metaCloudProvider },
  { id: AISENSY_PROVIDER, label: 'AiSensy', provider: aisensyProvider },
  { id: GUPSHUP_PROVIDER, label: 'Gupshup', provider: gupshupProvider },
  { id: WHATSMARKETING_PROVIDER, label: 'whatsmarketing.in', provider: whatsMarketingProvider },
];

const byId = new Map(BUSINESS_PROVIDERS.map((entry) => [entry.id, entry.provider]));

/** One named provider, whether or not it is the active one. */
export function businessProvider(id: string): WhatsAppBusinessProvider | null {
  return byId.get(id) ?? null;
}

/** The provider this CRM sends through today, or null when none is switched on. */
export function activeBusinessProvider(): WhatsAppBusinessProvider | null {
  const id = firstActiveIntegration(BUSINESS_PROVIDERS.map((entry) => entry.id));
  return id ? byId.get(id) ?? null : null;
}

/**
 * Is the official route usable at all?
 *
 * Asked by every screen before it offers a WhatsApp control, so a CRM with no
 * provider configured simply does not show one — rather than showing a button
 * that always fails, which is how people learn to distrust a feature.
 */
export function businessRouteReady(): boolean {
  const provider = activeBusinessProvider();
  return Boolean(provider && getIntegrationCredentials(provider.name));
}
