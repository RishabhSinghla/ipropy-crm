/**
 * The one gate between an AI-written pull request and main.
 *
 * The agent never merges its own work — not because it could not, but because
 * "the thing that wrote the code also decided it was fine" is not a review in
 * any sense. This module is the second pair of eyes, and they are mechanical:
 *
 *   1. Every check on the PR's head SHA is green (CI: typecheck, build, three
 *      test suites, docker image).
 *   2. The PR is not a draft.
 *   3. The diff touches nothing on the forbidden list — .env, secrets,
 *      render.yaml's deploy settings, workflow definitions. CI runs on a
 *      workflow file from the PR's own branch, so a modified workflow could
 *      green-light itself; the only honest answer is to refuse to run modified
 *      workflows at all.
 *
 * Merge method is squash, matching how every PR in this repo has landed.
 */
import { logger } from '../../utils/logger.js';

const FORBIDDEN_PATHS = [
  /^\.env/,
  /^\.github\/workflows\//,
  /^render\.yaml$/,
  /^Dockerfile$/,
  /^docker-compose\.yml$/,
  /secrets?\./i,
];

interface GhRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  token: string;
  body?: unknown;
}

async function gh<T>({ method, path, token, body }: GhRequest): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ipropy-crm',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface StatusRow {
  status: 'success' | 'failure' | 'pending' | 'error';
  context: string;
}

interface CheckRunsResponse {
  check_runs: { status: 'queued' | 'in_progress' | 'completed'; conclusion: string | null; name: string }[];
}

interface CombinedStatusResponse {
  statuses: StatusRow[];
}

/**
 * True when every CI voice on the head SHA has finished successfully.
 *
 * Returns false rather than throwing when nothing has reported yet — a PR
 * opened seconds ago has no checks, and "no evidence" is not "passed".
 */
async function allChecksGreen(repo: string, token: string, sha: string): Promise<boolean> {
  const [checks, statuses] = await Promise.all([
    gh<CheckRunsResponse>({ method: 'GET', token, path: `/repos/${repo}/commits/${sha}/check-runs` })
      .catch(() => null),
    gh<CombinedStatusResponse>({ method: 'GET', token, path: `/repos/${repo}/commits/${sha}/status` })
      .catch(() => null),
  ]);

  const checkRuns = checks?.check_runs ?? [];
  const statusRows = statuses?.statuses ?? [];

  // One voice saying "still running" or "failed" is enough to wait.
  for (const run of checkRuns) {
    if (run.status !== 'completed') return false;
    if (run.conclusion !== 'success' && run.conclusion !== 'skipped' && run.conclusion !== 'neutral') return false;
  }
  for (const row of statusRows) {
    if (row.status !== 'success') return false;
  }
  // And silence is not consent: with no checks at all, nothing has been proven.
  return checkRuns.length > 0 || statusRows.length > 0;
}

interface PrFile { filename: string }

/** True when the diff stays inside what the agent is allowed to touch. */
export function diffIsSafe(files: { filename: string }[]): boolean {
  return files.every((f) => !FORBIDDEN_PATHS.some((re) => re.test(f.filename)));
}

interface GhPull {
  number: number;
  html_url: string;
  draft: boolean;
  head: { sha: string };
}

export async function mergeIfGreen(input: {
  repo: string; token: string; pr: GhPull; feedbackId: string; userId: string;
}): Promise<boolean> {
  try {
    if (input.pr.draft) return false;

    const files = await gh<PrFile[]>({
      method: 'GET', token: input.token,
      path: `/repos/${input.repo}/pulls/${input.pr.number}/files?per_page=100`,
    });
    if (!diffIsSafe(files)) {
      logger.warn({ pr: input.pr.number }, 'agent PR touches forbidden paths — leaving for a human');
      return false;
    }

    if (!await allChecksGreen(input.repo, input.token, input.pr.head.sha)) return false;

    await gh({
      method: 'PUT', token: input.token,
      path: `/repos/${input.repo}/pulls/${input.pr.number}/merge`,
      body: { merge_method: 'squash', commit_title: `AI fix for feedback #${input.feedbackId.slice(0, 8)} (PR #${input.pr.number})` },
    });
    logger.info({ pr: input.pr.number }, 'agent PR merged — checks green and diff safe');
    return true;
  } catch (err) {
    logger.warn({ err, pr: input.pr.number }, 'merge attempt failed — will retry on next poll');
    return false;
  }
}
