/**
 * A thin client for Vtiger's Webservices API (webservice.php) — the same
 * REST-ish interface a self-hosted install exposes, which a Vtiger-cloud
 * account also carries.
 *
 * This is deliberately minimal: login, describe, query, retrieve. Nothing
 * here writes to Vtiger — the migration is one-directional, Vtiger to
 * iPropy, and this file cannot open the other way even by accident.
 *
 * Auth is the access key from My Preferences, **not** the login password.
 * Vtiger challenge/response never sends the password itself over the wire:
 *
 *   1. getchallenge(username)              -> a one-time token
 *   2. md5(token + accessKey)              -> what actually gets sent
 *   3. login(username, thatHash)           -> sessionName, good for a few hours
 */
import { createHash } from 'node:crypto';

export interface VtigerField {
  name: string;
  label: string;
  mandatory: boolean;
  editable: boolean;
  type: { name: string; refersTo?: string[] };
  picklistValues?: Record<string, string> | string[];
  defaultValue?: unknown;
}

export interface VtigerModuleDescribe {
  name: string;
  label: string;
  idPrefix: string;
  createable: boolean;
  updateable: boolean;
  deleteable: boolean;
  retrieveable: boolean;
  fields: VtigerField[];
}

export class VtigerApiError extends Error {
  constructor(message: string, public readonly operation: string) {
    super(message);
    this.name = 'VtigerApiError';
  }
}

export class VtigerClient {
  private sessionName: string | null = null;
  private readonly endpoint: string;

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly accessKey: string,
  ) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/webservice.php`;
  }

  private async call<T>(
    operation: string,
    params: Record<string, string> = {},
    method: 'GET' | 'POST' = 'GET',
  ): Promise<T> {
    const query = new URLSearchParams({ operation, ...params });
    const res = method === 'GET'
      ? await fetch(`${this.endpoint}?${query.toString()}`)
      : await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: query.toString(),
      });

    if (!res.ok) {
      throw new VtigerApiError(`HTTP ${res.status} ${res.statusText}`, operation);
    }
    const body = await res.json() as { success: boolean; result?: T; error?: { code: string; message: string } };
    if (!body.success) {
      throw new VtigerApiError(body.error?.message ?? 'unknown error', operation);
    }
    return body.result as T;
  }

  /** Establishes a session. Call once before anything else. */
  async login(): Promise<{ userId: string; vtigerVersion: string }> {
    const challenge = await this.call<{ token: string }>('getchallenge', { username: this.username });
    const hash = createHash('md5').update(challenge.token + this.accessKey).digest('hex');
    const result = await this.call<{ sessionName: string; userId: string; vtigerVersion: string }>(
      'login',
      { username: this.username, accessKey: hash },
      'POST',
    );
    this.sessionName = result.sessionName;
    return result;
  }

  private session(): string {
    if (!this.sessionName) throw new Error('call login() first');
    return this.sessionName;
  }

  /** Every module name this account can see (respects the login user's profile). */
  async listTypes(): Promise<string[]> {
    const result = await this.call<{ types: string[] }>('listtypes', { sessionName: this.session() });
    return result.types;
  }

  /** Full field list for one module, including picklist options and custom fields. */
  async describe(elementType: string): Promise<VtigerModuleDescribe> {
    return this.call<VtigerModuleDescribe>('describe', { sessionName: this.session(), elementType });
  }

  /**
   * Vtiger's restricted query language — roughly `SELECT ... FROM Module
   * WHERE ... LIMIT a,b`. No JOINs, no aggregates. Always append the
   * trailing `;` Vtiger requires; callers pass the query without it.
   */
  async query<T = Record<string, unknown>>(vtigerQl: string): Promise<T[]> {
    const withSemicolon = vtigerQl.trim().endsWith(';') ? vtigerQl.trim() : `${vtigerQl.trim()};`;
    return this.call<T[]>('query', { sessionName: this.session(), query: withSemicolon });
  }

  /** One record, every field populated — `query` silently omits some types. */
  async retrieve<T = Record<string, unknown>>(id: string): Promise<T> {
    return this.call<T>('retrieve', { sessionName: this.session(), id });
  }
}
