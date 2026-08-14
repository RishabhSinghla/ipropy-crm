/**
 * How this server reaches the CRM: over its own HTTP API, as a named person.
 *
 * The tempting shortcut is to open a Postgres connection and query the tables
 * directly — it is one dependency fewer and it is faster. It is also wrong, and
 * badly so. Every rule that makes this CRM safe lives *above* the tables:
 * profile permissions, the role hierarchy, sharing rules, field-level
 * visibility, validation, duplicate checks, workflows, and the audit trail.
 * A direct query has none of them. It would mean an assistant could read a
 * salary field a junior is not allowed to see, or write a lead that never
 * triggers the instant-response workflow, and nothing would appear in the
 * audit log to say it happened.
 *
 * Going through the API instead means the assistant is exactly as powerful as
 * the person whose key it is holding, and not one field more. That property is
 * the whole reason this is safe to point at real customer data, so it is worth
 * the extra hop.
 */

/** How the server identifies itself to the CRM, and which CRM it is talking to. */
export interface CrmConfig {
  baseUrl: string;
  apiKey: string;
  /** Refuse every write, whatever the model asks for. */
  readOnly: boolean;
}

export class CrmError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message);
    this.name = 'CrmError';
  }
}

/**
 * Reads the connection out of the environment.
 *
 * Deliberately fails loudly and in plain English. An MCP server that starts
 * with a missing key and then fails on the first tool call reports the problem
 * to the model, which paraphrases it — so the person sees "something went
 * wrong" rather than "you forgot the API key".
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CrmConfig {
  const baseUrl = (env.IPROPY_URL ?? '').trim().replace(/\/+$/, '');
  const apiKey = (env.IPROPY_API_KEY ?? '').trim();

  if (!baseUrl) {
    throw new Error(
      'IPROPY_URL is not set. Point it at your CRM, e.g. https://ipropy-crm.onrender.com',
    );
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(`IPROPY_URL must start with http:// or https:// — got "${baseUrl}"`);
  }
  if (!apiKey) {
    throw new Error(
      'IPROPY_API_KEY is not set. Create one in the CRM under Settings → Security → Connected apps.',
    );
  }

  return {
    baseUrl,
    apiKey,
    // Opt *in* to writing. Someone wiring this up for the first time, against
    // real customer records, should not discover the write tools by having one
    // fire.
    readOnly: (env.IPROPY_READ_ONLY ?? '').toLowerCase() !== 'false',
  };
}

export class CrmClient {
  constructor(private readonly config: CrmConfig) {}

  get readOnly(): boolean {
    return this.config.readOnly;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * `mutates` is stated, not guessed from the verb.
   *
   * The obvious rule — "GET is a read, anything else is a write" — is wrong
   * here, and wrong in a way that only shows up when you run it: searching
   * records is `POST /search`, because a filter is too big and too nested to
   * fit in a query string. Blocking on the verb made a read-only connection
   * refuse to search, which is the one thing a read-only connection is for.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    opts: { mutates?: boolean } = {},
  ): Promise<T> {
    if (this.config.readOnly && opts.mutates) {
      throw new CrmError(
        'This connection is read-only, so nothing was changed. To allow changes, set IPROPY_READ_ONLY=false where the connection is configured.',
        403,
      );
    }

    // 20s: long enough for a cold start on a sleeping free-tier server, short
    // enough that a model does not sit waiting forever on a dead host.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': this.config.apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new CrmError(`The CRM at ${this.config.baseUrl} did not answer within 20 seconds.`, 504);
      }
      throw new CrmError(
        `Could not reach the CRM at ${this.config.baseUrl}: ${(err as Error).message}`,
        502,
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const detail = (parsed as { message?: string } | null)?.message ?? text.slice(0, 300);
      // Rewritten into something a person can act on. The model relays these
      // verbatim, so "unauthorized" is a worse answer than saying which key to
      // check and where to make a new one.
      if (res.status === 401) {
        throw new CrmError(
          'The CRM rejected the API key. Make a new one under Settings → Security → Connected apps and update IPROPY_API_KEY.',
          401, detail,
        );
      }
      if (res.status === 403) {
        throw new CrmError(
          'Your CRM account is not allowed to do that. This connection has exactly the permissions you have when you sign in — ask an administrator if you need more.',
          403, detail,
        );
      }
      if (res.status === 404) throw new CrmError('No such record — it may have been deleted, or it may belong to someone whose records you cannot see.', 404, detail);
      if (res.status === 429) throw new CrmError('The CRM is rate-limiting this connection. Wait a minute and try again.', 429, detail);
      throw new CrmError(detail || `The CRM returned ${res.status}.`, res.status, detail);
    }

    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** A POST that only reads — record search, whose filter is too big for a URL. */
  search<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body, { mutates: false });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body, { mutates: true });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body, { mutates: true });
  }

  /** Who this key belongs to — used at startup to prove the connection works. */
  whoami(): Promise<{ id: string; fullName: string; email: string; isAdmin: boolean }> {
    return this.get('/api/auth/me');
  }
}
