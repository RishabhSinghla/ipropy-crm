import { BufferJSON, initAuthCreds, type AuthenticationCreds, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { db } from '../../../db/pool.js';
import { makeSecretBox } from '../../../core/secretbox.js';

/**
 * A linked device's keys, kept in the database and encrypted.
 *
 * Baileys ships `useMultiFileAuthState`, which writes a folder of JSON. That is
 * useless here twice over: Render replaces the container at will, so the folder
 * is gone on the next deploy and every agent is asked to scan again; and those
 * files are the credentials to somebody's WhatsApp account, sitting unencrypted
 * on a disk several people can reach.
 *
 * So the whole state is one encrypted blob on the account row. Its own salt, so
 * a linked session is not decryptable by whatever else shares the CRM's key.
 *
 * `BufferJSON` is not optional. Signal keys are `Buffer`s, and plain
 * `JSON.stringify` turns each into `{"type":"Buffer","data":[…]}`, which parses
 * back as an object and fails deep inside the crypto with an error that names
 * neither the key nor the account.
 */
const box = makeSecretBox('whatsapp-agent-session');

export interface StoredAuthState {
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

/** The subset of Baileys' auth-state contract this file has to satisfy. */
export interface DbAuthState {
  state: {
    creds: AuthenticationCreds;
    keys: {
      get: (type: keyof SignalDataTypeMap, ids: string[]) => Promise<Record<string, unknown>>;
      set: (data: Record<string, Record<string, unknown> | null>) => Promise<void>;
    };
  };
  saveCreds: () => Promise<void>;
  /** Forget everything, for a disconnect that must not leave a usable session behind. */
  clear: () => Promise<void>;
}

function serialise(state: StoredAuthState): string {
  return JSON.stringify(state, BufferJSON.replacer);
}

function deserialise(raw: string): StoredAuthState | null {
  try {
    const parsed = JSON.parse(raw, BufferJSON.reviver) as Partial<StoredAuthState>;
    if (!parsed?.creds) return null;
    return { creds: parsed.creds as AuthenticationCreds, keys: parsed.keys ?? {} };
  } catch {
    // A blob that will not parse is a blob that cannot log anybody in. Saying so
    // as "not linked" sends the agent to the QR screen, which is the only thing
    // that can actually fix it.
    return null;
  }
}

export async function loadAuthState(accountId: string): Promise<DbAuthState> {
  const row = await db.queryOne<{ auth_state_encrypted: string | null }>(
    `SELECT auth_state_encrypted FROM ipy_wa_account WHERE id = $1`,
    [accountId],
  );
  const decrypted = row?.auth_state_encrypted ? box.decrypt(row.auth_state_encrypted) : '';
  const stored = decrypted ? deserialise(decrypted) : null;

  const state: StoredAuthState = stored ?? { creds: initAuthCreds(), keys: {} };

  const persist = async (): Promise<void> => {
    await db.query(
      `UPDATE ipy_wa_account SET auth_state_encrypted = $2, updated_at = now() WHERE id = $1`,
      [accountId, box.encrypt(serialise(state))],
    );
  };

  return {
    state: {
      creds: state.creds,
      keys: {
        async get(type, ids) {
          const bucket = state.keys[type] ?? {};
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            const value = bucket[id];
            if (value !== undefined) out[id] = value;
          }
          return out;
        },
        async set(data) {
          for (const [type, values] of Object.entries(data)) {
            const bucket = state.keys[type] ?? (state.keys[type] = {});
            for (const [id, value] of Object.entries(values ?? {})) {
              // A null means "forget this key". Writing the null instead of
              // deleting it grows the blob for ever and hands Baileys a key it
              // has to treat as present.
              if (value === null || value === undefined) delete bucket[id];
              else bucket[id] = value;
            }
          }
          await persist();
        },
      },
    },
    saveCreds: persist,
    async clear() {
      await db.query(
        `UPDATE ipy_wa_account
            SET auth_state_encrypted = NULL, phone_number = NULL, display_name = NULL,
                status = 'disconnected', updated_at = now()
          WHERE id = $1`,
        [accountId],
      );
    },
  };
}
