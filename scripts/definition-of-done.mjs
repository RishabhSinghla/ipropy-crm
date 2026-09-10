#!/usr/bin/env node
/**
 * Walk the "Definition of Done" from the architecture brief against a running
 * CRM, in order, and say which parts actually hold.
 *
 * Every item here is a promise the product makes to an administrator: create a
 * field and it appears everywhere; rename it and nothing breaks; change its
 * type and the data comes with it; delete it and get it back. Each is easy to
 * believe and hard to know, because the failure is usually silent — a field
 * that exists but is absent from the export, a rename that empties a saved
 * view, a mapping that scores nothing.
 *
 *   API=http://localhost:4000 EMAIL=admin@ipropy.com PASSWORD=Admin@123 \
 *     node scripts/definition-of-done.mjs
 *
 * It creates fields with a `dod_` prefix and removes them at the end, so it is
 * safe against a development database. Do not point it at production.
 */
const API = process.env.API ?? 'http://localhost:4000';
const EMAIL = process.env.EMAIL ?? 'admin@ipropy.com';
const PASSWORD = process.env.PASSWORD ?? 'Admin@123';
const STAMP = Date.now().toString(36);

let token = '';
const results = [];
const created = [];

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) { console.error('login failed', login.status, login.body); process.exit(2); }
  token = login.body.token;

  const leads = (await call('GET', '/api/meta/modules/leads?includeInactive=true')).body;
  const blockId = leads.blocks?.[0]?.id;

  // ---- Create Currency Field → Budget/Demand Unit available -----------------
  const money = `dod_money_${STAMP}`;
  const madeMoney = await call('POST', '/api/meta/modules/leads/fields', {
    name: money, label: 'DoD Money', uitype: 'currency', blockId,
    config: { unitMaster: 'budget_demand', unitField: `${money}_unit` },
  });
  check('Create Currency Field', madeMoney.status === 201, `HTTP ${madeMoney.status}`);
  if (madeMoney.status === 201) created.push(madeMoney.body.id);

  const afterMoney = (await call('GET', '/api/meta/modules/leads?includeInactive=true')).body;
  const moneyField = afterMoney.fields.find((f) => f.name === money);
  const moneyUnit = afterMoney.fields.find((f) => f.name === `${money}_unit`);
  check('Currency field creates its Budget/Demand unit companion', Boolean(moneyUnit),
    moneyUnit ? '' : 'no companion unit field was created');

  const budgetUnits = await call('GET', '/api/meta/masters/units/budget_demand');
  check('Budget/Demand Unit Master is populated',
    budgetUnits.status === 200 && Array.isArray(budgetUnits.body) && budgetUnits.body.length >= 8,
    `HTTP ${budgetUnits.status}, ${Array.isArray(budgetUnits.body) ? budgetUnits.body.length : '?'} units`);

  // ---- Create Area Field → Area Unit Master available ------------------------
  const size = `dod_size_${STAMP}`;
  const madeSize = await call('POST', '/api/meta/modules/leads/fields', {
    name: size, label: 'DoD Size', uitype: 'area', blockId,
    config: { unitMaster: 'area', unitField: `${size}_unit` },
  });
  check('Create Area Field', madeSize.status === 201, `HTTP ${madeSize.status}`);
  if (madeSize.status === 201) created.push(madeSize.body.id);
  const areaUnits = await call('GET', '/api/meta/masters/units/area');
  check('Area Unit Master is populated',
    areaUnits.status === 200 && Array.isArray(areaUnits.body) && areaUnits.body.length >= 8,
    `HTTP ${areaUnits.status}, ${Array.isArray(areaUnits.body) ? areaUnits.body.length : '?'} units`);

  // ---- New Field → automatically available in Export -------------------------
  const csv = await call('POST', '/api/records/leads/export', { format: 'csv' });
  const header = typeof csv.body === 'string' ? csv.body.split('\n')[0] : '';
  check('New field is in the export without any extra step',
    header.includes('DoD Money'), header ? `header: ${header.slice(0, 90)}…` : `HTTP ${csv.status}`);
  check('The amount exports with its unit column', header.includes('DoD Money Unit'));

  // ---- Create Field → value round-trips through the record API ----------------
  const list = (await call('GET', '/api/records/leads?pageSize=1')).body;
  const recordId = list.rows?.[0]?.id;
  await call('PATCH', `/api/records/leads/${recordId}`, { [money]: 4500000 });
  const readBack = (await call('GET', `/api/records/leads/${recordId}`)).body;
  check('A value written to the new field reads back', Number(readBack.values?.[money]) === 4500000,
    `got ${JSON.stringify(readBack.values?.[money])}`);

  // ---- Change API Name → nothing breaks --------------------------------------
  const renamed = `${money}_renamed`;
  const rename = await call('PATCH', `/api/meta/fields/${madeMoney.body.id}`, { name: renamed });
  check('Change API Name', rename.status === 200, `HTTP ${rename.status}`);

  const afterRename = (await call('GET', `/api/records/leads/${recordId}`)).body;
  check('The value survives the rename', Number(afterRename.values?.[renamed]) === 4500000,
    `got ${JSON.stringify(afterRename.values?.[renamed])}`);

  const listAfter = await call('GET', '/api/records/leads?pageSize=5');
  check('The list still loads after a rename', listAfter.status === 200, `HTTP ${listAfter.status}`);

  const filtered = await call('POST', '/api/records/leads/search', {
    filter: { logic: 'AND', conditions: [{ field: renamed, operator: 'is_not_empty' }] }, pageSize: 5,
  });
  check('A filter on the renamed field works', filtered.status === 200,
    `HTTP ${filtered.status} ${filtered.status !== 200 ? JSON.stringify(filtered.body).slice(0, 120) : ''}`);

  const csv2 = await call('POST', '/api/records/leads/export', { format: 'csv' });
  check('The export still contains the field after its rename',
    typeof csv2.body === 'string' && csv2.body.split('\n')[0].includes('DoD Money'));

  // ---- Delete → Restore → data returns ---------------------------------------
  const hidden = await call('DELETE', `/api/meta/fields/${madeMoney.body.id}`);
  check('Delete Field (ordinary delete is recoverable)',
    hidden.status === 200 && hidden.body?.deactivated === true, `HTTP ${hidden.status}`);
  const restore = await call('PATCH', `/api/meta/fields/${madeMoney.body.id}`, { isActive: true });
  check('Restore Field', restore.status === 200, `HTTP ${restore.status}`);
  const afterRestore = (await call('GET', `/api/records/leads/${recordId}`)).body;
  check('Data returns with the restored field', Number(afterRestore.values?.[renamed]) === 4500000,
    `got ${JSON.stringify(afterRestore.values?.[renamed])}`);

  // ---- Contact → matching properties, Property → matching clients -------------
  /*
    Matching is asked about a lead that actually states a requirement.
    Pointing it at the first record in the table answers 200 with an empty
    list, which passes a status check and proves nothing — most leads have no
    budget, and "no matches" is the correct answer for them.
  */
  const withBudget = await call('POST', '/api/records/leads/search', {
    filter: { logic: 'AND', conditions: [{ field: 'budget', operator: 'is_not_empty' }] }, pageSize: 1,
  });
  const matchable = withBudget.body?.rows?.[0]?.id ?? recordId;
  const statedRequirement = Boolean(withBudget.body?.rows?.length);
  // Both matching endpoints answer `{ matches, requirement }`, not a bare
  // array — reading `.length` off the envelope reports 0 for a healthy call.
  const match = await call('GET', `/api/ai/match/leads/${matchable}?narrative=false&limit=5`);
  const matches = match.body?.matches;
  check('Contact → Find Matching Properties', match.status === 200 && Array.isArray(matches),
    `HTTP ${match.status} ${Array.isArray(matches) ? `${matches.length} matches` : JSON.stringify(match.body).slice(0, 120)}`);
  check('…and a contact with a stated budget gets at least one',
    !statedRequirement || (Array.isArray(matches) && matches.length > 0),
    statedRequirement ? '' : 'skipped — no lead in this database has a budget');

  /*
    Asked about a unit somebody actually matches, not the first row in the
    table. A property nobody wants correctly has no buyers, so pointing this at
    an arbitrary record answers 200 with an empty list and proves nothing —
    which is how a genuine one-directional bug survived a passing check.
  */
  const propId = matches?.[0]?.propertyId
    ?? (await call('GET', '/api/records/properties?pageSize=1')).body.rows?.[0]?.id;
  // The reverse direction is `/buyers-for/:propertyId` answering `{ buyers }`.
  // `/match/properties/:id` is the *forward* route asked about a property, and
  // reading it as the reverse one reports zero buyers for a healthy CRM.
  const buyers = await call('GET', `/api/ai/buyers-for/${propId}?limit=5&narrative=false`);
  const buyerRows = buyers.body?.buyers;
  check('Property → Find Matching Clients', buyers.status === 200 && Array.isArray(buyerRows),
    `HTTP ${buyers.status} ${Array.isArray(buyerRows) ? `${buyerRows.length} buyers` : JSON.stringify(buyers.body).slice(0, 120)}`);
  check('…and the two directions agree about the same pair',
    !matches?.length || (Array.isArray(buyerRows) && buyerRows.some((b) => b.recordId === matchable)),
    matches?.length ? 'the contact that matched this unit must appear against it' : 'skipped — no forward match to check');

  // ---- Cleanup ---------------------------------------------------------------
  for (const id of created) await call('DELETE', `/api/meta/fields/${id}?permanent=true&confirm=true`);
  const stray = (await call('GET', '/api/meta/modules/leads?includeInactive=true')).body
    .fields.filter((f) => f.name.startsWith('dod_'));
  for (const f of stray) await call('DELETE', `/api/meta/fields/${f.id}?permanent=true&confirm=true`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
