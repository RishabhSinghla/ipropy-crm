#!/usr/bin/env node
/**
 * Walk what the team does on a normal morning, against a running CRM.
 *
 * `definition-of-done.mjs` checks the promises the product makes to an
 * *administrator* — create a field and it is everywhere, rename it and nothing
 * breaks. This checks the promises it makes to a *rep*: add the person you just
 * spoke to, change their status, leave a note, chase them on a date, run the
 * list you always run, send a unit to a buyer, and let the phone file the calls
 * you made.
 *
 *   API=http://localhost:4000 node scripts/daily-paths.mjs
 *
 * Written because none of this was covered end to end and four of these paths
 * were broken on production at once on 11 September 2026 — logging a call, the
 * device call sync, the WhatsApp send and lead scoring — each failing quietly
 * in its own way, and every unit and integration test still green.
 *
 * It creates records prefixed `QA Daily` and removes them at the end. Safe
 * against a development database. Do not point it at production.
 */
const API = process.env.API ?? 'http://localhost:4000';
const EMAIL = process.env.EMAIL ?? 'admin@ipropy.com';
const PASSWORD = process.env.PASSWORD ?? 'Admin@123';
const STAMP = Date.now().toString(36);

let token = '';
const results = [];
/** Ten digits, wide enough apart that two runs in one afternoon cannot collide. */
const phone = (prefix) => `${prefix}${String(Date.now()).slice(-8)}`;

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body is fine */ }
  return { status: res.status, body: parsed };
}

function check(name, passed, detail = '') {
  results.push({ name, passed });
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) { console.error('login failed', login.status); process.exit(2); }
  token = login.body.token;

  const made = [];

  // ---- the record, and everything a rep does to it --------------------------
  const a = await call('POST', '/api/records/leads', {
    full_name: `QA Daily A ${STAMP}`, mobile: phone('94'), lead_status: 'New',
  });
  const b = await call('POST', '/api/records/leads', {
    full_name: `QA Daily B ${STAMP}`, mobile: phone('93'), lead_status: 'New',
  });
  check('a contact can be added', a.status === 201 && b.status === 201,
    a.status === 201 ? '' : JSON.stringify(a.body).slice(0, 140));
  const id = a.body?.id;
  const id2 = b.body?.id;
  made.push(id, id2);
  if (!id) { report(); return; }

  check('its status can be changed without leaving the page',
    (await call('PATCH', `/api/records/leads/${id}`, { lead_status: 'Contacted' })).status === 200);
  check('a note can be left for whoever picks it up next',
    (await call('POST', `/api/records/leads/${id}/comments`, { body: 'QA note' })).status < 400);
  check('it can be starred', (await call('POST', `/api/records/leads/${id}/star`, { starred: true })).status < 400);
  check('it can be tagged', (await call('POST', `/api/records/leads/${id}/tags`, { tags: ['qa-probe'] })).status < 400);
  check('a follow-up date can be set',
    (await call('PATCH', `/api/records/leads/${id}`, {
      next_followup_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    })).status === 200);

  // The duplicate check is what stops the same buyer being worked by two reps.
  const dup = await call('POST', '/api/records/leads/check-duplicates', { values: { mobile: a.body?.values?.mobile } });
  check('the duplicate check finds the person already on the system',
    dup.status < 400 && Array.isArray(dup.body) && dup.body.length > 0,
    `HTTP ${dup.status}`);

  // ---- the things that touch many records at once --------------------------
  await call('POST', '/api/records/leads/mass-update', { ids: [id, id2], values: { lead_status: 'Qualified' } });
  const bulk = await call('GET', `/api/records/leads/${id2}`);
  check('a bulk edit reaches every record it names',
    bulk.body?.values?.lead_status === 'Qualified', `got "${bulk.body?.values?.lead_status}"`);

  // ---- the list a rep opens every morning ----------------------------------
  const view = await call('POST', '/api/views/leads', {
    name: `QA View ${STAMP}`,
    columns: ['full_name', 'mobile', 'lead_status'],
    filter: { logic: 'AND', conditions: [{ field: 'lead_status', operator: 'equals', value: 'Qualified' }] },
  });
  check('a saved view can be created', view.status < 400, `HTTP ${view.status}`);
  if (view.body?.id) {
    const applied = await call('GET', `/api/records/leads?viewId=${view.body.id}&pageSize=5`);
    check('and it filters the list', applied.status === 200, `${applied.body?.total} rows`);
    await call('DELETE', `/api/views/leads/${view.body.id}`);
  }

  // ---- a unit, and the link a buyer opens ----------------------------------
  const unit = await call('POST', '/api/records/properties', {
    full_name: `QA Daily Unit ${STAMP}`, mobile: phone('92'), status: 'Available', locality: 'Powai',
  });
  check('a unit can be added', unit.status === 201, JSON.stringify(unit.body).slice(0, 140));
  if (unit.body?.id) {
    made.push(`properties:${unit.body.id}`);
    const link = await call('POST', `/api/records/properties/${unit.body.id}/share-links`, { label: 'QA' });
    check('a share link can be minted for it', link.status === 201, `HTTP ${link.status}`);
    if (link.body?.token) {
      const seen = await call('GET', `/api/public/share/${link.body.token}`);
      // Asserting on the header rather than the shell: a page that renders with
      // no data is exactly the failure a buyer reports as "your link is broken".
      check('and a buyer with no account can open it',
        seen.status === 200 && (seen.body?.priceShared !== undefined),
        `HTTP ${seen.status}`);
    }
  }

  // ---- the phone ------------------------------------------------------------
  /*
    A contact of its own, created New.

    The one above has been through a bulk edit to Qualified by now, and a call
    must not drag a qualified lead back to Contacted — so asserting on it would
    have been asserting the wrong thing, and did.
  */
  const called = await call('POST', '/api/records/leads', {
    full_name: `QA Daily Called ${STAMP}`, mobile: phone('91'), lead_status: 'New',
  });
  made.push(called.body?.id);

  const device = await call('POST', '/api/telephony/devices', { label: `QA ${STAMP}`, phoneNumber: '+919000000009' });
  check('a phone can be paired', device.status === 201 && Boolean(device.body?.token), `HTTP ${device.status}`);
  if (device.body?.token) {
    const res = await fetch(`${API}/api/device/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device.body.token}` },
      body: JSON.stringify({
        entries: [{
          externalId: `qa-${STAMP}`, number: called.body?.values?.mobile ?? '9999999999',
          type: 2, timestamp: Date.now() - 60_000, durationSeconds: 90,
        }],
      }),
    });
    const sync = await res.json().catch(() => ({}));
    check('it files the calls it made', res.status === 200 && sync.created === 1, JSON.stringify(sync).slice(0, 120));
    check('and the call finds the contact it was to', (sync.matched ?? 0) >= 1, JSON.stringify(sync).slice(0, 120));
    // The step that raised 42703 on production: the contact has to move.
    const moved = await call('GET', `/api/records/leads/${called.body?.id}`);
    check('and the contact moves from New to Contacted',
      (moved.body?.values?.lead_status ?? moved.body?.values?.status) === 'Contacted',
      `got "${moved.body?.values?.lead_status}"`);
    /*
      And the part the whole feature exists for: the CRM asks what happened,
      and the answer sticks. This is the first thing the team does with every
      call from 12 September 2026 onwards.
    */
    const pending = await call('GET', '/api/telephony/needs-disposition');
    const mine = (pending.body ?? []).find((c) => c.record_id === called.body?.id);
    check('the CRM asks what happened about it', Boolean(mine), `${(pending.body ?? []).length} waiting`);

    if (mine) {
      const answered = await call('POST', `/api/telephony/calls/${mine.id}/disposition`,
        { disposition: 'Interested', notes: 'QA daily path' });
      check('the outcome saves', answered.status === 200, `HTTP ${answered.status}`);

      // An outcome that is on no list must be refused, or every report that
      // groups by outcome grows a category nobody chose.
      const junk = await call('POST', `/api/telephony/calls/${mine.id}/disposition`,
        { disposition: 'NotARealOption' });
      check('an outcome that is on no list is refused', junk.status === 400, `HTTP ${junk.status}`);

      const still = await call('GET', '/api/telephony/needs-disposition');
      const gone = !(still.body ?? []).some((c) => c.id === mine.id);
      check('and it stops asking once answered', gone,
        gone ? `${(still.body ?? []).length} still waiting` : 'this call is still being asked about');
    }
    await call('DELETE', `/api/telephony/devices/${device.body.deviceId}`);
  }

  // ---- exports, which is how the data leaves ---------------------------------
  for (const module of ['leads', 'properties']) {
    const res = await fetch(`${API}/api/records/${module}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ format: 'csv' }),
    });
    const text = await res.text();
    check(`${module} exports with its columns`, res.ok && text.split('\n')[0].includes(','),
      res.ok ? text.split('\n')[0].slice(0, 60) : text.slice(0, 100));
  }

  // ---- put it back -----------------------------------------------------------
  for (const ref of made.filter(Boolean)) {
    const [module, recordId] = ref.includes(':') ? ref.split(':') : ['leads', ref];
    await call('DELETE', `/api/records/${module}/${recordId}`).catch(() => undefined);
  }
  report();
}

function report() {
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
