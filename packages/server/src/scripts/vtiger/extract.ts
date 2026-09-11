/**
 * Step 2: pull every row of every module that matters, to local disk.
 * Read-only against Vtiger, same as discover.ts — this never writes back.
 *
 * Built to survive Vtiger-cloud's rate limiting, which today refused
 * requests for hours after a burst of them, not minutes. Two defences:
 *
 *  * A flat, conservative pace between pages (this matters more than the
 *    client's own per-request backoff — a rolling-window limiter isn't
 *    fixed by retrying faster, only by asking less often overall).
 *  * A checkpoint file, written after every successful page. If a run gets
 *    rate-limited or killed partway through a 20,000-row module, re-running
 *    this script resumes from the last completed page instead of starting
 *    that module over — both to finish faster and to put less load on a
 *    live production account than a second full pass would.
 *
 * Output: one newline-delimited JSON file per module under `.output/raw/`,
 * plus `.output/checkpoint.json`. Both are gitignored — this is a full copy
 * of somebody's business data and never belongs in version control.
 */
import { mkdir, appendFile, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VtigerClient, VtigerApiError } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.output');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const CHECKPOINT_FILE = path.join(OUT_DIR, 'checkpoint.json');
const PAGE_SIZE = 100;
const DELAY_MS = 1800; // ~33 requests/minute sustained — see client.ts's header comment

// Every module worth pulling, and why. Vtiger's own admin/config modules
// (Roles, Groups, Currency, ProcessDesigner, AppDesigner, EmailTemplates,
// WebPages, Approvals, WorkOrders, Import, CsatSurveys, LineItem, Tax,
// ProductTaxes, CompanyDetails, Reactions) are deliberately excluded — they
// are Vtiger's own internal bookkeeping (its equivalent of iPropy's
// ipy_module/ipy_workflow tables), not customer data, and iPropy already has
// its own native version of everything they represent. Migrating them would
// be like porting one CMS's plugin-settings table into a different CMS.
export const MODULES = ['Contacts', 'ModComments', 'Calendar', 'Events', 'Emails', 'PhoneCalls', 'Users', 'Campaigns'] as const;
export type ModuleName = typeof MODULES[number];

interface Checkpoint {
  [module: string]: { offset: number; done: boolean };
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    return JSON.parse(await readFile(CHECKPOINT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  await writeFile(CHECKPOINT_FILE, JSON.stringify(cp, null, 2), 'utf8');
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) { console.error(`\n  ${name} is required.\n`); process.exit(1); }
  return value;
}

async function extractModule(
  client: VtigerClient, module: ModuleName, checkpoint: Checkpoint,
): Promise<number> {
  const state = checkpoint[module] ?? { offset: 0, done: false };
  if (state.done) {
    console.log(`  ${module}: already complete (resumed) — skipping`);
    return state.offset;
  }

  const filePath = path.join(RAW_DIR, `${module}.ndjson`);
  if (state.offset === 0) await writeFile(filePath, ''); // fresh start only — resume appends

  let offset = state.offset;
  while (true) {
    const rows = await client.query<Record<string, unknown>>(`select * from ${module} limit ${offset},${PAGE_SIZE}`);
    if (rows.length) {
      await appendFile(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
    offset += rows.length;
    checkpoint[module] = { offset, done: rows.length < PAGE_SIZE };
    await saveCheckpoint(checkpoint);
    process.stdout.write(`\r  ${module}: ${offset} row(s)...`);
    if (rows.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  console.log(''); // newline after the \r progress line
  return offset;
}

async function main(): Promise<void> {
  const fresh = process.argv.includes('--fresh');
  const url = required('VTIGER_URL');
  const username = required('VTIGER_USERNAME');
  const accessKey = required('VTIGER_ACCESS_KEY');

  await mkdir(RAW_DIR, { recursive: true });
  if (fresh) {
    await rm(CHECKPOINT_FILE, { force: true });
    console.log('  --fresh: ignoring any previous checkpoint, starting every module from 0.\n');
  }

  const client = new VtigerClient(url, username, accessKey);
  console.log(`  Connecting to ${url} as ${username}...`);
  await client.login();
  console.log('  Logged in.\n');

  const checkpoint = await loadCheckpoint();
  const totals: Record<string, number> = {};

  for (const module of MODULES) {
    try {
      totals[module] = await extractModule(client, module, checkpoint);
    } catch (err) {
      const message = err instanceof VtigerApiError ? err.message : String(err);
      console.log(`\n  ${module} stopped: ${message}`);
      console.log('  Progress up to this point is saved. Re-run this script to resume — already-complete modules are skipped, and this module continues from its last completed page.\n');
      process.exit(1);
    }
    // Extra breathing room between modules, on top of the per-page pace.
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log('\n  Extraction complete:');
  for (const [module, count] of Object.entries(totals)) console.log(`    ${module}: ${count} row(s)`);
  console.log(`\n  Raw data: ${RAW_DIR}`);
  console.log('  Next step: npm run vtiger:migrate\n');
}

main().catch((err) => {
  console.error('\n  Extraction failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
