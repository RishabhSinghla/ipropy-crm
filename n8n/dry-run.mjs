/**
 * Runs the workflow's Code nodes against invented but realistic data.
 *
 * n8n's own editor will tell you a Code node is valid JavaScript. It will not
 * tell you that your shortlist keeps eight photos of the same bedroom, or that
 * a model returning junk takes the whole run down. Those are logic bugs and
 * they only show up when the code actually runs, so this fakes just enough of
 * n8n — $input, $json, $('Node') — to execute them in order.
 *
 * It proves the logic. It cannot prove OneDrive paths, credentials or the
 * model's answers; only one real property can do that.
 *
 *   node n8n/dry-run.mjs
 */
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./ipropy-content-factory.json', import.meta.url)));
const codeOf = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

/** Output of each node, keyed by name — this is what $('Node') reads. */
const outputs = {};
const asItems = (v) => (Array.isArray(v) ? v : [v]);

function run(nodeName, inputItems) {
  const items = asItems(inputItems);
  const $input = {
    first: () => items[0],
    last: () => items[items.length - 1],
    all: () => items,
  };
  const $ = (name) => {
    if (!(name in outputs)) throw new Error(`$('${name}') read before that node ran`);
    const prev = asItems(outputs[name]);
    return { first: () => prev[0], last: () => prev[prev.length - 1], item: prev[0], all: () => prev };
  };
  const fn = new Function('$input', '$json', '$', `${codeOf(nodeName)}`);
  const out = fn($input, items[0]?.json, $);
  outputs[nodeName] = out;
  return out;
}

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : '  <- ' + detail}`);
  if (!cond) failures++;
};

// --------------------------------------------------------------------------
console.log('\n1. Read the request');
outputs['Shoot finished'] = [{ json: { body: {
  propertyId: 'prop-123', folder: '/IPROPY-PROPERTIES/GREENFIELD/B12-4BHK/', sessionId: 's-1',
} } }];
let cfg = run('Read the request', outputs['Shoot finished']);
check('trailing/leading slashes stripped', cfg[0].json.folder === 'IPROPY-PROPERTIES/GREENFIELD/B12-4BHK', cfg[0].json.folder);
check('originals path derived', cfg[0].json.originalsPath.endsWith('/01 Originals'), cfg[0].json.originalsPath);
check('crmBaseUrl defaulted', cfg[0].json.crmBaseUrl === 'http://localhost:4000');
check('maxPhotos capped at 60', run('Read the request', [{ json: { body: {
  propertyId: 'p', folder: 'f', maxPhotos: 5000 } } }])[0].json.maxPhotos === 60);

try {
  run('Read the request', [{ json: { body: { folder: 'f' } } }]);
  check('missing propertyId is refused', false, 'it was accepted');
} catch (e) {
  check('missing propertyId is refused', /propertyId/.test(e.message), e.message);
}
outputs['Read the request'] = cfg;   // restore the good one

// --------------------------------------------------------------------------
console.log('\n2. Pick photos to judge');
const listing = [{ json: { value: [
  { id: '1', name: 'IMG_001.jpg', size: 3_000_000, file: { mimeType: 'image/jpeg' } },
  { id: '2', name: 'IMG_002.HEIC', size: 4_000_000, file: { mimeType: 'image/heic' } },
  { id: '3', name: 'notes.pdf',   size: 900_000,   file: { mimeType: 'application/pdf' } },
  { id: '4', name: 'thumb.jpg',   size: 12_000,    file: { mimeType: 'image/jpeg' } },
  { id: '5', name: 'A folder' },
] } }];
const picked = run('Pick photos to judge', listing);
check('keeps jpg and heic', picked.length === 2, `kept ${picked.length}`);
check('drops the pdf, the thumbnail and the folder',
  !picked.some((p) => ['notes.pdf', 'thumb.jpg', 'A folder'].includes(p.json.name)));

try {
  run('Pick photos to judge', [{ json: { value: [] } }]);
  check('an empty folder fails loudly', false, 'it returned quietly');
} catch (e) {
  check('an empty folder fails loudly', /No photos/.test(e.message), e.message);
}

// --------------------------------------------------------------------------
console.log('\n3. Collect rating — must survive a junk answer');
outputs['Photo to data URI'] = [{ json: { fileId: '1', name: 'IMG_001.jpg' } }];
const good = run('Collect rating', [{ json: { choices: [{ message: {
  content: '{"keep":true,"score":8,"room":"drawing room","why":"bright and wide"}' } }] } }]);
check('parses a good answer', good[0].json.keep === true && good[0].json.score === 8);

const junk = run('Collect rating', [{ json: { choices: [{ message: {
  content: 'Sure! Here is the JSON you asked for:' } }] } }]);
check('junk answer costs one photo, does not throw', junk[0].json.keep === false, JSON.stringify(junk[0].json));

// --------------------------------------------------------------------------
console.log('\n4. Rank and shortlist');
const ratings = [
  { keep: true,  score: 9, room: 'drawing room', name: 'a.jpg' },
  { keep: true,  score: 8, room: 'drawing room', name: 'b.jpg' },
  { keep: true,  score: 7, room: 'drawing room', name: 'c.jpg' },
  { keep: true,  score: 6, room: 'kitchen',      name: 'd.jpg' },
  { keep: true,  score: 5, room: 'bedroom',      name: 'e.jpg' },
  { keep: false, score: 2, room: 'bathroom',     name: 'f.jpg', why: 'blurred' },
].map((json) => ({ json }));
const ranked = run('Rank and shortlist', ratings);
const first3 = ranked[0].json.shortlist.slice(0, 3).map((p) => p.room);
check('one photo per room comes first', new Set(first3).size === 3, first3.join(', '));
check('best of the duplicates still included', ranked[0].json.shortlist.length === 5);
check('rejected photos are kept with reasons', ranked[0].json.rejected[0].why === 'blurred');
check('counts are honest', ranked[0].json.judged === 6 && ranked[0].json.kept === 5);

// A shoot where the model rejected everything must not crash the next node.
const allBad = run('Rank and shortlist', [{ json: { keep: false, score: 0, room: 'x', name: 'z.jpg', why: 'dark' } }]);
check('a shoot with nothing worth keeping still returns', allBad[0].json.shortlist.length === 0);
outputs['Rank and shortlist'] = ranked;

// --------------------------------------------------------------------------
console.log('\n5. Build the files');
outputs['Get property from CRM'] = [{ json: {
  label: 'B12 Greenfield 4BHK', configuration: '4 BHK', locality: 'Greenfield Colony',
} }];
const built = run('Build the files', [{ json: { choices: [{ message: { content: JSON.stringify({
  instagram: 'Four bedrooms in Greenfield Colony.', facebook: 'Now available in Greenfield.',
  whatsapp: 'Hi — the 4BHK at B12 is available. Shall I send photos?',
  portal_title: '4 BHK Builder Floor in Greenfield Colony',
  portal_description: 'A 250 sq yd builder floor.', hashtags: ['faridabad', '#realestate'],
}) } }] } }]);
const f = built[0].json;
check('captions.md names the property', f.captions.includes('B12 Greenfield 4BHK'));
check('hashtags all carry a #', (f.captions.match(/#faridabad/) && f.captions.match(/#realestate/)) !== null);
check('listing.md lists photos in order', /1\. a\.jpg/.test(f.listing), f.listing.split('\n').slice(-3).join(' | '));
check('_status.json is valid JSON', (() => { try { JSON.parse(f.status); return true; } catch { return false; } })());
check('status records what was rejected and why', JSON.parse(f.status).rejected[0].why === 'blurred');
check('summary reads plainly', /5 of 6 photos shortlisted/.test(f.summary), f.summary);

const empty = run('Build the files', [{ json: { choices: [{ message: { content: 'not json at all' } }] } }]);
check('a model that returns prose still produces files', typeof empty[0].json.captions === 'string');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
