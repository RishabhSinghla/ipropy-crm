/**
 * The control plane's vocabulary.
 *
 * A "tenant" here is a paying business, and — because the architecture is one
 * database per customer (see SAAS.md) — also exactly one Postgres database. The
 * two are the same thing on purpose: isolation is a property of the connection
 * string rather than of every query anyone writes from now on.
 */

/**
 * `provisioning` exists because creating a database, migrating and seeding it
 * takes tens of seconds and can fail halfway. A row is written *before* that
 * work starts, so a crash leaves evidence rather than an orphaned database
 * nobody knows about.
 *
 * `suspended` is for non-payment: the tenant's data is untouched and their
 * database still exists. `archived` means we have stopped serving them and the
 * database may be gone.
 */
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'archived' | 'failed';

export interface Tenant {
  id: string;
  /** URL-safe, unique, permanent. Used for the subdomain and the database name. */
  slug: string;
  name: string;
  /** Which starting data model this database was seeded with. */
  templateKey: string;
  status: TenantStatus;
  plan: string;
  adminEmail: string;
  /** Decrypted only when something is about to connect. Never logged. */
  databaseUrl: string;
  /** Where the app serving this tenant lives, when it has its own deployment. */
  appUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What `list` returns — same shape without the secret, so it is safe to print. */
export type TenantSummary = Omit<Tenant, 'databaseUrl'>;

export interface TenantEvent {
  id: string;
  tenantId: string;
  kind: string;
  detail: string | null;
  createdAt: string;
}
