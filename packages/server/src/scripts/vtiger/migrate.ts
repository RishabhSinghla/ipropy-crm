/**
 * THE single command: extract everything from Vtiger, then load everything
 * into iPropy. `npm run vtiger:migrate` and nothing else has to be typed.
 *
 * Two commands under the hood, run in strict sequence and never interleaved
 * — Contacts must be fully in `ipy_record_external_ref` before notes/emails/
 * calls try to attach to them. Each stays independently runnable
 * (`vtiger:extract`, `vtiger:load`) for resuming a specific step, but this
 * is the one a person actually types.
 *
 * Both steps are resumable and idempotent, so running this twice — on
 * purpose, or because Vtiger's rate limit cut a run short — never
 * duplicates anything; it picks up wherever the last run stopped.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(script: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', path.join(__dirname, script), ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
    child.on('error', reject);
  });
}

async function main(): Promise<void> {
  const fresh = process.argv.includes('--fresh');

  console.log('══════════════════════════════════════════');
  console.log(' Vtiger → iPropy migration — full run');
  console.log('══════════════════════════════════════════\n');

  console.log('── Step 1/2: extract ──\n');
  await run('extract.ts', fresh ? ['--fresh'] : []);

  console.log('\n── Step 2/2: load ──\n');
  await run('load.ts');

  console.log('══════════════════════════════════════════');
  console.log(' Done. See load-report.json for the full detail —');
  console.log(' new picklist values added, unmapped owners, and');
  console.log(' anything that failed or landed with no parent.');
  console.log('══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n  Migration stopped partway through:', err instanceof Error ? err.message : err);
  console.error('  Nothing already loaded was undone. Re-run `npm run vtiger:migrate` —');
  console.error('  both steps resume from where they stopped rather than starting over.\n');
  process.exit(1);
});
