/**
 * Symmetric encryption for secrets this system stores on someone's behalf.
 *
 * Lifted out of `core/settings/integrations.ts` unchanged — same algorithm, same
 * key derivation, same `enc:v1:` envelope — so every credential already in
 * `ipy_integration` still decrypts. The only thing that moved is that the salt
 * is now a parameter, because the control plane stores a different class of
 * secret (a customer's database connection string) and two purposes should not
 * share one key.
 *
 * Keys derive from JWT_SECRET, which is why rotating it means re-entering every
 * stored credential. That trade was made deliberately: no second required
 * environment variable to lose.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const ENC_PREFIX = 'enc:v1:';

export interface SecretBox {
  encrypt: (plain: string) => string;
  /** Returns '' on tampered or undecryptable input — callers treat that as "not configured". */
  decrypt: (value: string | undefined | null) => string;
}

export function makeSecretBox(salt: string): SecretBox {
  const deriveKey = (): Buffer => crypto.scryptSync(config.auth.jwtSecret, salt, 32);

  return {
    encrypt(plain: string): string {
      if (!plain) return '';
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
    },

    decrypt(value: string | undefined | null): string {
      if (!value) return '';
      // Rows written before encryption existed; re-encrypted on their next save.
      if (!value.startsWith(ENC_PREFIX)) return value;
      try {
        const raw = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
        const iv = raw.subarray(0, 12);
        const tag = raw.subarray(12, 28);
        const enc = raw.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
      } catch (err) {
        logger.error({ err, salt }, 'failed to decrypt a stored secret');
        return '';
      }
    },
  };
}
