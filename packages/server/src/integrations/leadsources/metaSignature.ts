/**
 * Meta's `X-Hub-Signature-256` check.
 *
 * This lived in `integrations/whatsapp/provider.ts` and came out with the rest
 * of WhatsApp on 17 September 2026. It was never WhatsApp's alone: the Facebook
 * lead webhook is public — Meta cannot hold a secret of ours — so this
 * signature is the only thing separating a real lead from an invented one.
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';

export function verifyMetaSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  // An unconfigured secret fails closed in production and open in development,
  // where nobody has Meta's app secret to sign a local request with.
  if (!secret) return !config.isProd;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.slice(7);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
