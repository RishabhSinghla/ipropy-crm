/**
 * Creating a customer's database on Neon.
 *
 * One Neon **project** per customer rather than one database inside a shared
 * project: a project has its own compute, its own backups and its own restore,
 * so restoring one customer to yesterday cannot touch anybody else. That is the
 * entire reason for choosing database-per-customer, and sharing a project would
 * quietly give most of it back.
 *
 * Optional by design. With no `NEON_API_KEY` the provisioner asks for a
 * connection string instead, which is how the first few customers will be
 * onboarded anyway — and how anyone not hosting on Neon can use this at all.
 */
import { logger } from '../utils/logger.js';

export interface NeonProject {
  projectId: string;
  /** Pooled connection string — what the app should use. */
  connectionUri: string;
}

interface CreateProjectResponse {
  project?: { id?: string };
  connection_uris?: { connection_uri?: string }[];
}

export type FetchLike = typeof globalThis.fetch;

/**
 * `region` is a Neon region id such as `aws-ap-southeast-1`. Singapore is the
 * closest to India that Neon offers and matches where the app runs.
 */
export async function createNeonProject(opts: {
  apiKey: string;
  name: string;
  region?: string;
  fetchImpl?: FetchLike;
}): Promise<NeonProject> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  const res = await doFetch('https://console.neon.tech/api/v2/projects', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      project: {
        name: opts.name,
        region_id: opts.region ?? 'aws-ap-southeast-1',
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Neon refused to create the project (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json() as CreateProjectResponse;
  const connectionUri = json.connection_uris?.[0]?.connection_uri;
  const projectId = json.project?.id;

  if (!connectionUri || !projectId) {
    // Neon answered 2xx without the one thing we need. Failing here beats
    // recording a tenant with an empty connection string.
    throw new Error('Neon created the project but returned no connection string.');
  }

  logger.info({ projectId }, 'created a Neon project for a new customer');
  return { projectId, connectionUri };
}
