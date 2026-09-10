/**
 * The bridge between a non-technical owner and an autonomous coding agent.
 *
 * The deal this module implements: the owner reports a problem in his own
 * words — Hinglish, a screenshot, whatever he has — and everything after the
 * Submit button is machinery he never sees. The report becomes a GitHub issue
 * (the engineering system of record), an agent working from that issue opens a
 * pull request, CI proves it, and the fix deploys. His part is one tap on
 * "Done" or "Still wrong" when it lands.
 *
 * Every GitHub call degrades the way the rest of this CRM's integrations do:
 * unconfigured means "cannot reach GitHub", never "crash". A report submitted
 * with the pipeline off is still stored, still listed, still answerable — it
 * just waits.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { NotFoundError } from '../../utils/errors.js';
import { notify, notifyMany } from '../notifications/index.js';
import { complete } from '../../ai/client.js';
import { untrustedRule, fenceId, fenced } from '../../ai/untrusted.js';
import { makeSecretBox } from '../secretbox.js';
import { mergeIfGreen } from './mergeGate.js';
import { analyzeAndEmail } from './analyzeAndEmail.js';

/** Where the GitHub half of the config lives, same as every other integration. */
export interface GithubConfig {
  token: string;
  repo: string; // owner/name
  /** Labels that trigger the agent, comma-separated. */
  triggerLabels: string;
  /** Auto-merge a green PR without waiting for a human. */
  autoMerge: boolean;
}

const DEFAULT_REPO = 'RishabhSinghla/ipropy-crm';
const DEFAULT_LABELS = 'ai-fix';

/**
 * Read the GitHub integration row. Returns null when unconfigured — the
 * caller decides what "waiting" looks like.
 *
 * The row is written by the same generic admin integrations path as every
 * other provider (PUT /api/admin/integrations/github_agent): `credentials.token`
 * holds a GitHub PAT sealed with the shared secretbox, `config.repo` the
 * repository, `config.autoMerge` the merge policy. No bespoke writer exists on
 * purpose — one place writes integrations, and this is one.
 */
const { decrypt } = makeSecretBox('ipropy-integration-credentials');

export async function getGithubConfig(): Promise<GithubConfig | null> {
  try {
    const row = await db.queryOne<{ credentials: Record<string, string>; config: Record<string, string> }>(
      `SELECT credentials, config FROM ipy_integration WHERE provider = 'github_agent' AND is_active = true`,
    );
    if (!row) return null;
    const sealed = row.credentials?.token;
    const token = sealed ? decrypt(sealed) : '';
    if (!token) return null;
    const cfg = row.config ?? {};
    return {
      token,
      repo: cfg.repo || DEFAULT_REPO,
      triggerLabels: cfg.triggerLabels || DEFAULT_LABELS,
      autoMerge: cfg.autoMerge !== 'false',
    };
  } catch {
    return null;
  }
}

/** Sealed-token read used by the poller. */
async function readGithubToken(): Promise<{ token: string; repo: string } | null> {
  const cfg = await getGithubConfig();
  return cfg ? { token: cfg.token, repo: cfg.repo } : null;
}

/**
 * Push the agent's AI settings to GitHub repo *variables*, where the workflow
 * reads them. The admin edits the card; the next ticket runs on the new
 * provider — no redeploys to change a model.
 *
 * The API key is deliberately NOT mirrored here: repo variables are readable
 * by anyone with repo read access, and repo *secrets* need a libsodium sealed
 * box this server has no dependency for. The key is pasted once as a repo
 * secret (AGENT_AI_API_KEY) or left as the existing TOKENROUTER_API_KEY —
 * both are documented on the card and in FEEDBACK-PIPELINE.md.
 */
export async function syncAgentAiToRepo(): Promise<void> {
  const ghc = await readGithubToken();
  if (!ghc) return;
  const row = await db.queryOne<{ config: Record<string, string> }>(
    `SELECT config FROM ipy_integration WHERE provider = 'github_agent' AND is_active = true`,
  );
  const cfg = row?.config ?? {};

  const setVariable = async (name: string, value: string): Promise<void> => {
    const headers = {
      authorization: `Bearer ${ghc.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ipropy-crm',
    };
    // Create-or-update: GitHub has no upsert for variables. A 409 on POST
    // means "already exists" — fall through to the PATCH.
    const post = await fetch(`https://api.github.com/repos/${ghc.repo}/actions/variables`, {
      method: 'POST', headers, body: JSON.stringify({ name, value }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (post?.status === 201) return;
    await fetch(`https://api.github.com/repos/${ghc.repo}/actions/variables/${name}`, {
      method: 'PATCH', headers, body: JSON.stringify({ name, value }),
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => logger.warn({ err, name }, 'could not set repo variable'));
  };

  await setVariable('AGENT_AI_BASE_URL', cfg.aiBaseUrl || 'https://api.tokenrouter.com/v1');
  await setVariable('AGENT_AI_MODEL', cfg.aiModel || 'z-ai/glm-5.3-free');
}

// ---------------------------------------------------------------------------
// The REST half: everything GitHub's API needs, wrapped small.
// ---------------------------------------------------------------------------

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

export interface IssueRef { number: number; html_url: string }

/** Create the engineering ticket from a report the owner already filed in-app. */
export async function createIssue(input: {
  repo: string; token: string;
  title: string; body: string; labels: string[];
}): Promise<IssueRef> {
  return gh<IssueRef>({
    method: 'POST', token: input.token,
    path: `/repos/${input.repo}/issues`,
    body: { title: input.title, body: input.body, labels: input.labels },
  });
}

export async function addComment(input: {
  repo: string; token: string; issue: number; body: string;
}): Promise<void> {
  await gh({
    method: 'POST', token: input.token,
    path: `/repos/${input.repo}/issues/${input.issue}/comments`,
    body: { body: input.body },
  });
}

export interface GhPull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  merged: boolean;
  draft: boolean;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  /** Present when this "issue" row is actually a pull request (timeline entries). */
  pull_request?: unknown;
}

export async function findLinkedPr(input: {
  repo: string; token: string; branch: string;
}): Promise<GhPull | null> {
  // The agent works on ai/<issue>-<rand>, so the exact-match `head=` filter
  // cannot be used. List this issue's timeline instead: the agent's PR body
  // always says "Fixes #N", which makes GitHub cross-link the PR to this
  // issue — that cross-reference is the reliable map from issue to PR, robust
  // to however a title is phrased. Take the newest one: a follow-up from the
  // reporter produces a second, newer PR.
  const issueNo = input.branch.replace(/^ai\//, '');
  const events = await gh<{ event: string; source?: { issue?: { number: number; html_url: string; state: string; draft: boolean; merged_at: string | null; pull_request?: unknown; head?: { sha: string } } } }[]>({
    method: 'GET', token: input.token,
    path: `/repos/${input.repo}/issues/${issueNo}/timeline?per_page=100`,
  }).catch(() => []);
  const linked = events
    .filter((e) => e.event === 'cross-referenced' && e.source?.issue?.html_url?.includes('/pull/'))
    .map((e) => e.source!.issue!);
  const pr = linked[linked.length - 1];
  if (!pr) return null;
  // Normalise into the GhPull shape the poller and merge gate speak.
  return {
    number: pr.number,
    html_url: pr.html_url,
    state: pr.state === 'closed' ? 'closed' : 'open',
    merged_at: pr.merged_at ?? null,
    merged: Boolean(pr.merged_at),
    draft: pr.draft ?? false,
    title: '',
    head: { ref: '', sha: pr.head?.sha ?? '' },
    base: { ref: 'main' },
    pull_request: pr.pull_request,
  };
}

// ---------------------------------------------------------------------------
// The AI triage half: understand the report well enough to name it.
// ---------------------------------------------------------------------------

/**
 * Turn one report into the engineering ticket.
 *
 * The reporter wrote in Hinglish; the issue is written in English with the
 * original quoted verbatim, because the agent reasons in English but must
 * never lose the exact words — half of a bug report's value is in what the
 * person actually said. The AI summary is written back in simple Hinglish so
 * the reporter can confirm he was understood before anything is built.
 */
export async function writeTicket(input: {
  text: string;
  kind: string;
  severity: string;
  moduleName: string | null;
  route: string | null;
  reporter: string;
  screenshotNotes: string[];
}): Promise<{ title: string; body: string; aiSummary: string } | null> {
  const id = fenceId();
  const result = await complete({
    feature: 'feedback_triage',
    system: [
      'You are the intake desk of an Indian real-estate CRM called iPropy.',
      'An owner or team member has reported something about the software, in Hinglish or English.',
      'Produce a JSON object with exactly three string keys:',
      '"title"    an English engineering title, max 80 chars, starting with "Fix:", "Add:" or "Answer:" as fits the kind',
      '"aiSummary" one or two sentences in simple Hinglish (Roman script) confirming what you understood, addressed to the reporter as "aap"',
      '"body"     a short English restatement of the request for an engineer, 2-6 sentences, mentioning the module/screen if known',
      untrustedRule(id),
      'Respond with a single valid JSON object and nothing else.',
    ].join('\n'),
    prompt: [
      `Reporter: ${input.reporter}`,
      `Kind: ${input.kind}`,
      `Severity: ${input.severity}`,
      input.moduleName ? `Module: ${input.moduleName}` : '',
      input.route ? `Screen route: ${input.route}` : '',
      fenced(id, 'What the reporter wrote', input.text),
      ...input.screenshotNotes.map((n, i) => fenced(id, `Screenshot ${i + 1} shows`, n)),
    ].filter(Boolean).join('\n'),
    maxTokens: 1200,
    temperature: 0.2,
  });
  if (!result?.text.trim()) return null;
  const { parseJson } = await import('../../ai/client.js');
  const parsed = parseJson<{ title?: string; aiSummary?: string; body?: string }>(result.text);
  if (!parsed?.title) return null;
  return {
    title: String(parsed.title).slice(0, 120),
    aiSummary: String(parsed.aiSummary ?? ''),
    body: String(parsed.body ?? ''),
  };
}

/**
 * Describe a screenshot in words, so the text-only agent can "see" it.
 *
 * The coding agent's model is text-only (measured: the gateway answers "I
 * cannot view images" for picture inputs). This runs at intake, through the
 * CRM's own configured vision model — the same one that reads documents and
 * shoot photos — and folds what it sees into the issue as words. If no vision
 * provider answers, the screenshot still attaches and the reporter's words
 * still carry; the agent just gets one fewer clue.
 */
export async function describeScreenshot(bytes: Buffer, mimeType: string): Promise<string | null> {
  try {
    const { modelFor } = await import('../settings/aiModels.js');
    const answer = await complete({
      feature: 'feedback_screenshot',
      model: await modelFor('vision'),
      system: 'You look at a screenshot of a CRM called iPropy and describe exactly what is visible, '
        + 'for an engineer who cannot see it. Name the screen, the fields, any error message text '
        + 'verbatim, and anything that looks wrong. Three sentences maximum. Plain statements, no guesses.',
      prompt: 'Describe this screenshot.',
      images: [{ data: bytes, mimeType }],
      maxTokens: 900,
      temperature: 0.1,
    });
    return answer?.text.trim() || null;
  } catch (err) {
    logger.debug({ err }, 'screenshot description unavailable');
    return null;
  }
}

// ---------------------------------------------------------------------------
// The event log every timeline reads from.
// ---------------------------------------------------------------------------

export type FeedbackStage =
  | 'submitted' | 'triaging' | 'working' | 'reviewing'
  | 'fixed' | 'reopened' | 'failed' | 'declined';

export async function logEvent(feedbackId: string, stage: FeedbackStage, note: string, actor = 'system'): Promise<void> {
  await db.query(
    `INSERT INTO ipy_feedback_event (feedback_id, stage, note, actor) VALUES ($1,$2,$3,$4)`,
    [feedbackId, stage, note, actor],
  );
}

export async function setStatus(feedbackId: string, status: FeedbackStage, note: string, extra?: {
  issueNumber?: number; issueUrl?: string; prNumber?: number; prUrl?: string; aiSummary?: string;
}): Promise<void> {
  await db.query(
    `UPDATE ipy_feedback
        SET status = $2,
            issue_number = COALESCE($3, issue_number),
            issue_url   = COALESCE($4, issue_url),
            pr_number   = COALESCE($5, pr_number),
            pr_url      = COALESCE($6, pr_url),
            ai_summary  = COALESCE($7, ai_summary),
            updated_at  = now()
      WHERE id = $1`,
    [feedbackId, status,
      extra?.issueNumber ?? null, extra?.issueUrl ?? null,
      extra?.prNumber ?? null, extra?.prUrl ?? null,
      extra?.aiSummary ?? null],
  );
  await logEvent(feedbackId, status, note);
}

// ---------------------------------------------------------------------------
// Submission — the one write path.
// ---------------------------------------------------------------------------

export interface SubmitInput {
  userId: string;
  text: string;
  kind: 'bug' | 'idea' | 'question';
  severity: 'blocking' | 'important' | 'minor';
  moduleName: string | null;
  recordId: string | null;
  route: string | null;
}

/**
 * Store the report, then fire AI+email in the background.
 *
 * The report is stored first (so it's never lost), then analyzeAndEmail runs
 * after the HTTP 201 returns to the client — that function uses Gemini vision
 * to read screenshots, builds a super-prompt, and emails it to the owner.
 */
export async function submitFeedback(input: SubmitInput): Promise<string> {
  const row = await db.queryOne<{ id: string; share_token: string }>(
    `INSERT INTO ipy_feedback (user_id, text, kind, severity, module_name, record_id, route)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, share_token`,
    [input.userId, input.text, input.kind, input.severity, input.moduleName, input.recordId, input.route],
  );
  if (!row) throw new Error('feedback insert failed');
  await logEvent(row.id, 'submitted', 'Report mil gayi — AI analyze kar raha hai, owner ko email bhej dega.');

  // The owner hears the moment a report lands — a bell row now, a lock-screen
  // push the moment he has subscribed a device (Settings → Alerts). This works
  // with nothing configured anywhere: no SMTP, no keys, no third party. The
  // email leg below is the fuller copy of the same news, when it is set up.
  // The reporter is excluded — reporting your own bug should not ping you.
  const admins = await db.query<{ id: string }>(
    `SELECT id FROM ipy_user WHERE is_admin AND is_active AND id <> $1`,
    [input.userId],
  );
  if (admins.rows.length) {
    await notifyMany(admins.rows.map((u) => u.id), {
      kind: 'feedback',
      title: 'Naya report aaya hai',
      body: input.text.length > 100 ? `${input.text.slice(0, 100)}…` : input.text,
      link: '/feedback',
      recordId: row.id,
    });
  }

  // Fire and forget: the reporter's request is done; AI analysis + email happen in background.
  void analyzeAndEmail(row.id).catch((err: Error) => {
    logger.error({ err, feedbackId: row.id }, 'analyzeAndEmail failed');
  });

  return row.id;
}

/**
 * Everything from triage to issue creation, for a fresh report or a reopened
 * one. Idempotent per stage: a crash after the issue exists leaves a row that
 * the poller can still pick up.
 */
export async function startPipeline(feedbackId: string): Promise<void> {
  const fb = await db.queryOne<{
    id: string; text: string; kind: string; severity: string;
    module_name: string | null; record_id: string | null; route: string | null;
    share_token: string; issue_number: number | null; user_id: string;
    reporter_first: string | null; reporter_last: string | null;
  }>(
    `SELECT f.*, u.first_name AS reporter_first, u.last_name AS reporter_last
       FROM ipy_feedback f JOIN ipy_user u ON u.id = f.user_id
      WHERE f.id = $1`,
    [feedbackId],
  );
  if (!fb) return;

  // Screenshot notes: describe each attached image at intake, so the
  // text-only agent gets eyes. Skips silently when no vision model answers.
  const atts = await db.query<{ id: string; storage_key: string; mime_type: string }>(
    `SELECT id, storage_key, mime_type FROM ipy_attachment
      WHERE record_id = $1 AND mime_type LIKE 'image/%' ORDER BY created_at`,
    [feedbackId],
  );
  const notes: string[] = [];
  if (atts.rows.length) {
    const { getDriver } = await import('../storage/index.js');
    const driver = await getDriver();
    for (const att of atts.rows.slice(0, 3)) {
      const bytes = await driver.read(att.storage_key).catch(() => null);
      if (!bytes?.length) continue;
      // Screenshots can be big; shrink before sending, the way capture vision does.
      const small = await downscale(bytes);
      const note = await describeScreenshot(small, 'image/jpeg');
      if (note) notes.push(note);
    }
  }

  const reporter = `${fb.reporter_first ?? ''} ${fb.reporter_last ?? ''}`.trim() || 'A team member';
  const ticket = await writeTicket({
    text: fb.text, kind: fb.kind, severity: fb.severity,
    moduleName: fb.module_name, route: fb.route, reporter, screenshotNotes: notes,
  });

  if (!ticket) {
    // No AI at all: still file the issue with the raw text as the title, so
    // the pipeline never dies at the door. Deterministic fallback, like
    // every AI feature in this repo.
    await fileIssue(fb, {
      title: `${fb.kind === 'bug' ? 'Fix' : fb.kind === 'idea' ? 'Add' : 'Answer'}: ${fb.text.slice(0, 70)}`,
      aiSummary: 'AI ke bhi report ticket ban gayi. Team dekhegi.',
      body: fb.text,
    }, notes);
    return;
  }

  await fileIssue(fb, ticket, notes);
}

async function downscale(bytes: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(bytes, { failOn: 'none' }).rotate().resize({ width: 1400, withoutEnlargement: true })
      .jpeg({ quality: 80 }).toBuffer();
  } catch {
    return bytes;
  }
}

async function fileIssue(
  fb: { id: string; text: string; kind: string; severity: string; module_name: string | null; route: string | null; share_token: string; user_id: string },
  ticket: { title: string; aiSummary: string; body: string },
  screenshotNotes: string[],
): Promise<void> {
  const ghc = await readGithubToken();
  if (!ghc) {
    await setStatus(fb.id, 'submitted', 'AI team is not configured yet — report save ho gayi hai, baad mein issue banegi.', {
      aiSummary: ticket.aiSummary,
    });
    return;
  }

  const labels = ['ai-fix', `kind:${fb.kind}`, `sev:${fb.severity}`];
  const body = [
    `> ${ticket.body}`,
    '',
    '## Original report (verbatim)',
    '',
    '```',
    fb.text,
    '```',
    '',
    ...(fb.module_name ? [`Module: **${fb.module_name}**`, ''] : []),
    ...(fb.route ? [`Screen route: \`${fb.route}\``, ''] : []),
    `Severity: **${fb.severity}** · Kind: **${fb.kind}**`,
    '',
    ...(screenshotNotes.length
      ? ['## What the screenshots show', '', ...screenshotNotes.map((n) => `- ${n}`), '']
      : []),
    '---',
    '',
    `Backlink: this issue was filed automatically from the iPropy CRM. The reporter is ${'`'}${fb.user_id.slice(0, 8)}${'`'} ` +
      'and verifies fixes in-app. Post progress as comments; they are shown to the reporter as a timeline.',
    '',
    `**Agent instructions**: implement, test and open a PR. Never force-push to main. Never touch migrations other than adding new forward-only ones. Never edit .env or secrets.`,
  ].join('\n');

  try {
    const issue = await createIssue({ repo: ghc.repo, token: ghc.token, title: ticket.title, body, labels });
    await setStatus(fb.id, 'triaging', 'Engineering ticket ban gayi — AI engineer kaam shuru kar raha hai.', {
      issueNumber: issue.number, issueUrl: issue.html_url, aiSummary: ticket.aiSummary,
    });
  } catch (err) {
    logger.error({ err, feedbackId: fb.id }, 'issue creation failed');
    await setStatus(fb.id, 'failed', 'GitHub par ticket nahi ban paayi. Report saved hai — dobara try karein.', {});
  }
}

// ---------------------------------------------------------------------------
// The poller half: watch issues/PRs and translate progress into the timeline.
// ---------------------------------------------------------------------------

interface OpenFeedbackRow {
  id: string;
  user_id: string;
  issue_number: number;
  pr_number: number | null;
  status: string;
}

/**
 * Called by the scheduler's tick. For every active report with an issue, look
 * at GitHub and move the row's status forward. One pass, no state in memory —
 * safe to run on any number of processes, exactly like the queue drain.
 */
export async function pollFeedback(): Promise<void> {
  const ghc = await readGithubToken();
  if (!ghc) return;

  const open = await db.query<OpenFeedbackRow>(
    `SELECT id, user_id, issue_number, pr_number, status
       FROM ipy_feedback
      WHERE issue_number IS NOT NULL
        AND status IN ('submitted','triaging','working','reviewing','reopened')
      ORDER BY updated_at
      LIMIT 25`,
  );
  if (!open.rows.length) return;

  for (const fb of open.rows) {
    try {
      await advanceOne(ghc, fb);
    } catch (err) {
      logger.debug({ err, feedbackId: fb.id }, 'feedback poll skipped one row');
    }
    // Be a polite API citizen even when there are twenty-five rows.
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function advanceOne(ghc: { token: string; repo: string }, fb: OpenFeedbackRow): Promise<void> {
  const issue = await gh<{ state: string; pull_request: unknown }>({
    method: 'GET', token: ghc.token, path: `/repos/${ghc.repo}/issues/${fb.issue_number}`,
  });

  // The PR is read before the issue's closure is judged. A merged PR closes
  // its issue — "Fixes #N" auto-closes on the squash — and a poll that saw
  // the closure first would report a live, deployed fix as a declined ticket,
  // and a declined row is terminal: the reporter would never be asked to
  // verify the very fix that just shipped.
  let pr: GhPull | null = null;
  try {
    pr = await findLinkedPr({ repo: ghc.repo, token: ghc.token, branch: `ai/${fb.issue_number}` });
  } catch { /* no PR yet — normal mid-work state */ }

  // A human closed the issue: a merged PR still means a shipped fix (handled
  // below), but no PR at all — or an unmerged one — means the work was
  // stopped before it shipped. Respect it as "declined". (The agent's own
  // no-change verdict closes its issue and lands here on purpose.)
  if (issue.state === 'closed' && (!pr || !pr.merged)) {
    await setStatus(fb.id, 'declined', 'Ticket band kar di gayi. Agar zaroorat ho to naya report bhejein.');
    await notify({
      userId: fb.user_id, kind: 'feedback',
      title: 'Aapki report band ho gayi',
      body: 'Engineering team ne ticket close kar di — naya report bhej sakte hain.',
      link: '/feedback',
    });
    return;
  }

  if (!pr) {
    if (fb.status !== 'triaging' && fb.status !== 'reopened') {
      await setStatus(fb.id, 'triaging', 'AI engineer issue ko samajh raha hai.');
    }
    return;
  }

  // Link the PR the first time it appears.
  if (fb.pr_number !== pr.number) {
    await db.query(
      `UPDATE ipy_feedback SET pr_number = $2, pr_url = $3, updated_at = now() WHERE id = $1`,
      [fb.id, pr.number, pr.html_url],
    );
    await logEvent(fb.id, 'working', 'AI engineer ne ek pull request khol di hai — code likha ja raha hai.', 'agent');
  }

  if (pr.merged) {
    // Merged: production gets it on Render's auto-deploy of main. Mark fixed
    // and hand it to the reporter for verification.
    await setStatus(fb.id, 'fixed', 'Fix merge ho gaya aur live deploy ho raha hai — kripya check karein: theek lage to "Done" dabayein.', {
      prNumber: pr.number, prUrl: pr.html_url,
    });
    await notify({
      userId: fb.user_id, kind: 'feedback',
      title: 'Aapki report ka fix ready hai',
      body: 'AI engineer ne theek kar diya — ek baar check karke batayein.',
      link: '/feedback',
    });
    return;
  }

  if (pr.state === 'closed' && !pr.merged) {
    // The agent (or a reviewer) closed the PR without merging. If the issue is
    // still open the agent may retry; reflect reality on the timeline.
    await logEvent(fb.id, 'working', 'Pull request band ho gaya bina merge ke — agent dobara try kar raha hai.', 'agent');
    return;
  }

  // PR open. Green CI + auto-merge on → the poller is the merger, so the
  // deploy gate stays the thing that protects main.
  if (fb.status !== 'reviewing') {
    await setStatus(fb.id, 'reviewing', 'Code likha ja chuka hai — CI tests chala raha hai.', {
      prNumber: pr.number, prUrl: pr.html_url,
    });
  }

  const cfg = await getGithubConfig();
  if (cfg?.autoMerge) {
    await mergeIfGreen({ repo: ghc.repo, token: ghc.token, pr, feedbackId: fb.id, userId: fb.user_id });
  }
}

// ---------------------------------------------------------------------------
// Routes-facing helpers: the reporter's half of the conversation.
// ---------------------------------------------------------------------------

/**
 * The reporter's one-word verdict after the fix deployed.
 *
 * "Done" closes the loop: fixed, verified, story over. "Still wrong" reopens
 * the same row with the follow-up appended — the agent re-runs with the whole
 * conversation, which is how the second half of a fix usually gets found.
 */
export async function verifyFeedback(input: {
  feedbackId: string; userId: string; ok: boolean; note?: string;
}): Promise<void> {
  const fb = await db.queryOne<{ id: string; user_id: string; issue_number: number | null; status: string }>(
    `SELECT id, user_id, issue_number, status FROM ipy_feedback WHERE id = $1`,
    [input.feedbackId],
  );
  if (!fb || fb.user_id !== input.userId) throw new NotFoundError('Report not found');

  if (input.ok) {
    if (fb.status !== 'fixed') return; // nothing to verify yet
    await logEvent(fb.id, 'fixed', 'Reporter ne confirm kiya — kaam poora. Dhanyavaad!', 'reporter');
    await db.query(`UPDATE ipy_feedback SET status = 'declined', updated_at = now()
      WHERE id = $1 AND status = 'fixed'`, [fb.id]);
    // The engineering ticket closes with the confirmation, so the repo's history
    // says who verified it and when.
    const ghc = await readGithubToken();
    if (ghc && fb.issue_number) {
      await addComment({
        repo: ghc.repo, token: ghc.token, issue: fb.issue_number,
        body: `Verified in-app by the reporter${input.note ? `: ${input.note}` : ''}. Closing.`,
      }).catch(() => undefined);
      await gh({ method: 'PATCH', token: ghc.token, path: `/repos/${ghc.repo}/issues/${fb.issue_number}`, body: { state: 'closed' } })
        .catch(() => undefined);
    }
    return;
  }

  // Still wrong: reopen with the follow-up.
  await db.query(
    `UPDATE ipy_feedback SET status = 'reopened', updated_at = now() WHERE id = $1`,
    [fb.id],
  );
  await logEvent(fb.id, 'reopened', input.note?.trim()
    ? `Reporter: abhi theek nahi hai — "${input.note.trim()}"` : 'Reporter: abhi theek nahi hai.', 'reporter');

  const ghc = await readGithubToken();
  if (ghc && fb.issue_number) {
    await addComment({
      repo: ghc.repo, token: ghc.token, issue: fb.issue_number,
      body: `The reporter checked the deployed fix and it is still wrong${input.note ? `:\n\n> ${input.note}` : '.'} ` +
        'Please investigate again and iterate — same issue, follow-up context above.',
    }).catch(() => undefined);
    // Reopen the GitHub issue too, so the agent's trigger (label) fires again
    // through the workflow and it picks the follow-up up.
    await gh({ method: 'PATCH', token: ghc.token, path: `/repos/${ghc.repo}/issues/${fb.issue_number}`, body: { state: 'open' } })
      .catch(() => undefined);
  }
}

/** Everything the reporter's timeline shows, one query. */
export async function listFeedback(userId: string): Promise<unknown[]> {
  const rows = await db.query(
    `SELECT f.id, f.text, f.kind, f.severity, f.status, f.ai_summary, f.module_name, f.route,
            f.issue_url, f.pr_url, f.created_at, f.updated_at,
            (SELECT jsonb_agg(jsonb_build_object('stage', e.stage, 'note', e.note, 'actor', e.actor,
                                                'at', to_char(e.created_at, 'YYYY-MM-DD HH24:MI'))
                             ORDER BY e.created_at)
               FROM ipy_feedback_event e WHERE e.feedback_id = f.id) AS events,
            (SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.file_name, 'mime', a.mime_type))
               FROM ipy_attachment a WHERE a.record_id = f.id) AS screenshots
       FROM ipy_feedback f
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
      LIMIT 100`,
    [userId],
  );
  return rows.rows;
}

