/**
 * Runs the workflow's Code nodes against invented but realistic data.
 *
 * n8n's editor will tell you a Code node is valid JavaScript. It will not tell
 * you that your ordering puts the bathroom first, or that a model returning
 * junk takes the whole run down. Those are logic bugs and they only show up
 * when the code actually runs, so this fakes just enough of n8n — $input,
 * $json, $('Node') — to execute them in order.
 *
 * It proves the logic. It cannot prove the worker, the credentials or the
 * model's answers; only one real property can do that.
 *
 *   node n8n/dry-run.mjs
 */
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./ipropy-content-factory.json', import.meta.url)));
const codeOf = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

const outputs = {};
const asItems = (v) => (Array.isArray(v) ? v : [v]);

function run(nodeName, inputItems) {
  const items = asItems(inputItems);
  const $input = { first: () => items[0], last: () => items[items.length - 1], all: () => items };
  const $ = (name) => {
    if (!(name in outputs)) throw new Error(`$('${name}') read before that node ran`);
    const prev = asItems(outputs[name]);
    return { first: () => prev[0], last: () => prev[prev.length - 1], item: prev[0], all: () => prev };
  };
  const out = new Function('$input', '$json', '$', codeOf(nodeName))($input, items[0]?.json, $);
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
  propertyId: 'prop-123', folder: '/GREENFIELD/B12-4BHK/', sessionId: 's-1',
} } }];
let cfg = run('Read the request', outputs['Shoot finished']);
check('slashes trimmed', cfg[0].json.folder === 'GREENFIELD/B12-4BHK', cfg[0].json.folder);
check('crmBaseUrl defaulted', cfg[0].json.crmBaseUrl === 'http://localhost:4000');
try {
  run('Read the request', [{ json: { body: { folder: 'f' } } }]);
  check('missing propertyId refused', false, 'accepted');
} catch (e) { check('missing propertyId refused', /propertyId/.test(e.message)); }
outputs['Read the request'] = cfg;

// --------------------------------------------------------------------------
console.log('\n2. Split previews');
const prepared = [{ json: { folder: 'GREENFIELD/B12-4BHK', previews: [
  { master: 'IMG_4471.jpg', preview: 'data:image/jpeg;base64,AAA' },
  { master: 'IMG_4472.jpg', preview: 'data:image/jpeg;base64,BBB' },
] } }];
check('one item per photo', run('Split previews', prepared).length === 2);
try {
  run('Split previews', [{ json: { folder: 'x', previews: [] } }]);
  check('an empty folder fails loudly', false, 'returned quietly');
} catch (e) { check('an empty folder fails loudly', /no usable photos/i.test(e.message)); }

// --------------------------------------------------------------------------
console.log('\n3. Collect label — must survive junk');
outputs['Each photo'] = [{ json: { master: 'IMG_4471.jpg' } }];
const good = run('Collect label', [{ json: { choices: [{ message: {
  content: '{"room":"drawing room","subject":"sofa and window","broken":false}' } }] } }]);
check('parses a good answer', good[0].json.room === 'drawing room');

const junk = run('Collect label', [{ json: { choices: [{ message: { content: 'Sure! Here you go:' } }] } }]);
check('junk still yields a publishable photo', junk[0].json.room === 'photo' && junk[0].json.broken === false,
  JSON.stringify(junk[0].json));

// --------------------------------------------------------------------------
console.log('\n4. Put them in order — order, do not cull');
const labels = [
  { master: 'a.jpg', room: 'bathroom',     subject: '', broken: false },
  { master: 'b.jpg', room: 'drawing room', subject: '', broken: false },
  { master: 'c.jpg', room: 'drawing room', subject: '', broken: false },
  { master: 'd.jpg', room: 'kitchen',      subject: '', broken: false },
  { master: 'e.jpg', room: 'bedroom',      subject: '', broken: false },
  { master: 'f.jpg', room: 'floor',        subject: '', broken: true, why: 'photo of a shoe' },
].map((json) => ({ json }));
const ordered = run('Put them in order', labels);
const plan = ordered[0].json.plan;

check('nothing usable is culled', ordered[0].json.publishing === 5, `published ${ordered[0].json.publishing}`);
check('the broken one is dropped', plan.every((p) => p.master !== 'f.jpg'));
check('and recorded with a reason', ordered[0].json.dropped[0].why === 'photo of a shoe');
check('drawing room leads, bathroom does not', plan[0].label === 'drawing room', plan[0].label);
check('one of each room before the second of any',
  new Set(plan.slice(0, 4).map((p) => p.label)).size === 4,
  plan.slice(0, 4).map((p) => p.label).join(', '));
check('the duplicate angle is kept, just later',
  plan.some((p) => p.master === 'c.jpg') && plan.findIndex((p) => p.master === 'c.jpg') >= 3);
check('order numbers are 1..n with no gaps',
  plan.every((p, i) => p.order === i + 1));

const allBroken = run('Put them in order', [{ json: { master: 'z.jpg', room: 'x', broken: true, why: 'blurred' } }]);
check('a shoot with nothing publishable still returns', allBroken[0].json.plan.length === 0);
outputs['Put them in order'] = ordered;

// --------------------------------------------------------------------------
console.log('\n5. Build the files');
outputs['Get property from CRM'] = [{ json: { label: 'B12 Greenfield 4BHK', configuration: '4 BHK' } }];
const built = run('Build the files', [{ json: { choices: [{ message: { content: JSON.stringify({
  instagram: 'Four bedrooms in Greenfield Colony.', facebook: 'Now available.',
  whatsapp: 'Hi — the 4BHK at B12 is available. Shall I send photos?',
  status_line: '4 BHK · Greenfield · ready to move',
  google: 'New 4 BHK builder floor listed in Greenfield Colony.',
  shorts_title: 'Inside a 4 BHK builder floor in Faridabad',
  portal_title: '4 BHK Builder Floor in Greenfield Colony',
  portal_description: 'A 250 sq yd builder floor.', hashtags: ['faridabad', '#realestate'],
}) } }] } }]);
const f = built[0].json;

check('plan is passed through to the worker', Array.isArray(f.plan) && f.plan.length === 5);
check('three files are produced', Object.keys(f.files).length === 3, Object.keys(f.files).join(', '));
check('captions cover every channel',
  ['Instagram', 'Facebook', 'WhatsApp', 'Status', 'Google', 'Shorts'].every((k) => f.files['captions.md'].includes(k)));
check('hashtags all carry a #', /#faridabad/.test(f.files['captions.md']) && /#realestate/.test(f.files['captions.md']));
check('listing.md carries the photo order', /1\. drawing room/.test(f.files['listing.md']));
check('_status.json is valid JSON', (() => { try { JSON.parse(f.files['_status.json']); return true; } catch { return false; } })());
check('status records what was not published',
  JSON.parse(f.files['_status.json']).not_published[0].why === 'photo of a shoe');
check('summary reads plainly', /5 photos published/.test(f.summary), f.summary);

const prose = run('Build the files', [{ json: { choices: [{ message: { content: 'not json' } }] } }]);
check('a model that answers with prose still produces files',
  typeof prose[0].json.files['captions.md'] === 'string');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} problem(s)\n`);
process.exit(failures === 0 ? 0 : 1);
