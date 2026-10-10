import { BadRequestError } from '../../../utils/errors.js';
import { activeBusinessProvider } from './registry.js';

/** Check the provider, not a potentially stale local approval badge. */
export async function assertApprovedTemplate(template: { name: string; language: string; params: string[] }): Promise<void> {
  const provider = activeBusinessProvider();
  if (!provider) throw new BadRequestError('No official WhatsApp provider is switched on.');
  if (!provider.capabilities.has('templateSync')) {
    throw new BadRequestError('This provider cannot verify template approval. Use a provider with template sync for approved-template sending.');
  }
  const found = (await provider.listTemplates()).find((t) => t.name === template.name && t.language === template.language);
  if (!found || found.status.trim().toUpperCase() !== 'APPROVED') {
    throw new BadRequestError('WhatsApp was not sent: this template is missing or not approved. Sync templates and check its approval status.');
  }
  if (found.variableCount !== template.params.length || template.params.some((p) => !p.trim())) {
    throw new BadRequestError('WhatsApp was not sent: template variables are missing or the wording has changed. Check the field mapping.');
  }
}
