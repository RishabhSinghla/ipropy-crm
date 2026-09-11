/**
 * Step 1 of the Vtiger migration: look, don't touch.
 *
 * Connects to the live Vtiger account read-only, lists every module the
 * migration user can see, pulls full field definitions (including custom
 * fields and picklist values) for each, and grabs three sample records so
 * real data shapes — not the stock demo schema — drive the field mapping.
 *
 * Writes one JSON report and changes nothing. The field mapping (which
 * Vtiger module/field becomes which iPropy one) is designed by hand against
 * this report before any extraction runs.
 *
 *   VTIGER_URL='https://xxxx.od2.vtiger.com' \
 *   VTIGER_USERNAME='you@example.com' \
 *   VTIGER_ACCESS_KEY='...' \
 *   npm run vtiger:discover
 *
 * The access key is under My Preferences in Vtiger — never the login
 * password. Nothing here is written back to Vtiger; every call is a read.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VtigerClient, VtigerApiError } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.output');

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`\n  ${name} is required. See the comment at the top of discover.ts.\n`);
    process.exit(1);
  }
  return value;
}

// Modules no real-estate CRM migration needs: Vtiger's own scaffolding,
// integration bookkeeping and features iPropy doesn't have an equivalent
// for. Filtered from the *sample-pulling* pass only — they still show up
// in the module list so nothing is silently hidden from the report.
const SKIP_SAMPLING = new Set([
  'SMSNotifier', 'ModComments', 'Integration', 'PriceBooks', 'PriceBookProductRel',
  'Vendors', 'PurchaseOrder', 'SalesOrder', 'Quotes', 'Invoice', 'Currency',
  'ServiceContracts', 'Services', 'PBXManager',
]);

async function main(): Promise<void> {
  const url = required('VTIGER_URL');
  const username = required('VTIGER_USERNAME');
  const accessKey = required('VTIGER_ACCESS_KEY');

  const client = new VtigerClient(url, username, accessKey);

  console.log(`\n  Connecting to ${url} as ${username}...`);
  const session = await client.login();
  console.log(`  Logged in. Vtiger ${session.vtigerVersion}, user id ${session.userId}.\n`);

  const types = await client.listTypes();
  console.log(`  ${types.length} module(s) visible to this user:\n    ${types.join(', ')}\n`);

  const report: Record<string, unknown> = {
    fetchedAt: new Date().toISOString(),
    vtigerUrl: url,
    vtigerVersion: session.vtigerVersion,
    moduleCount: types.length,
    modules: {} as Record<string, unknown>,
  };
  const modules = report.modules as Record<string, unknown>;

  for (const type of types) {
    process.stdout.write(`  describing ${type}...`);
    try {
      const described = await client.describe(type);
      const fieldSummary = described.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type.name,
        refersTo: f.type.refersTo,
        mandatory: f.mandatory,
        picklistValues: Array.isArray(f.picklistValues)
          ? f.picklistValues
          : f.picklistValues ? Object.values(f.picklistValues) : undefined,
      }));

      let samples: unknown[] = [];
      let sampleError: string | undefined;
      if (described.retrieveable && !SKIP_SAMPLING.has(type)) {
        try {
          samples = await client.query(`select * from ${type} limit 0,3`);
        } catch (err) {
          sampleError = err instanceof VtigerApiError ? err.message : String(err);
        }
      }

      modules[type] = {
        label: described.label,
        idPrefix: described.idPrefix,
        createable: described.createable,
        updateable: described.updateable,
        deleteable: described.deleteable,
        retrieveable: described.retrieveable,
        fieldCount: fieldSummary.length,
        fields: fieldSummary,
        sampleCount: samples.length,
        samples,
        sampleError,
      };
      console.log(` ${fieldSummary.length} fields, ${samples.length} sample row(s)${sampleError ? ` (sample failed: ${sampleError})` : ''}`);
    } catch (err) {
      const message = err instanceof VtigerApiError ? err.message : String(err);
      modules[type] = { error: message };
      console.log(` FAILED: ${message}`);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `discovery-${new Date().toISOString().slice(0, 10)}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n  Written: ${outFile}`);
  console.log('  Nothing was changed in Vtiger. Next step: design the field mapping against this report.\n');
}

main().catch((err) => {
  console.error('\n  Discovery failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
