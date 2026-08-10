/**
 * The operator console, as one file with no build step.
 *
 * A second React app would need its own bundler, its own deploy and its own
 * dependency updates, to render four tables that one person looks at. This is
 * served straight from the control plane, which is also the only place it should
 * ever be reachable from: the customer-facing app on :5173 is one customer's
 * deployment and must never carry the list of the others.
 *
 * Styling deliberately echoes the CRM — same slate/indigo palette, same weights
 * — so it reads as part of the product rather than a debug page.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iPropy · Operators</title>
<style>
  :root {
    --bg:#f8fafc; --card:#fff; --line:#e2e8f0; --ink:#0f172a; --muted:#64748b;
    --brand:#4f46e5; --ok:#059669; --warn:#b45309; --bad:#dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --ink:#f1f5f9; --muted:#94a3b8; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); background:var(--card); }
  h1 { margin:0; font-size:17px; font-weight:650; letter-spacing:-.01em; }
  h1 span { color:var(--muted); font-weight:400; }
  h2 { font-size:13px; font-weight:650; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 10px; }
  main { padding:24px; max-width:1100px; margin:0 auto; display:grid; gap:24px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .stat b { display:block; font-size:24px; font-weight:650; letter-spacing:-.02em; }
  .stat span { color:var(--muted); font-size:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); padding:10px 16px; border-bottom:1px solid var(--line); font-weight:600; }
  td { padding:12px 16px; border-bottom:1px solid var(--line); vertical-align:middle; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid; }
  .pill.active{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}
  .pill.suspended{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:color-mix(in srgb,var(--warn) 10%,transparent)}
  .pill.failed,.pill.past_due{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
  .pill.provisioning,.pill.trialing{color:var(--muted);border-color:var(--line);background:transparent}
  button { font:inherit; font-size:12px; font-weight:600; padding:5px 11px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer; }
  button:hover { border-color:var(--brand); color:var(--brand); }
  button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  button.primary:hover { opacity:.9; color:#fff; }
  button:disabled { opacity:.45; cursor:default; }
  .banner { padding:11px 16px; border-radius:10px; font-size:13px; border:1px solid; }
  .banner.warn { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 30%,transparent); background:color-mix(in srgb,var(--warn) 8%,transparent); }
  .muted { color:var(--muted); }
  .empty { padding:28px 16px; text-align:center; color:var(--muted); font-size:13px; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  dialog { border:1px solid var(--line); border-radius:12px; background:var(--card); color:var(--ink); padding:20px; max-width:460px; }
  dialog::backdrop { background:rgba(15,23,42,.5); }
</style>
</head>
<body>
<header>
  <h1>iPropy <span>· operators</span></h1>
</header>
<main>
  <div id="banners"></div>
  <div class="stats" id="stats"></div>

  <section>
    <h2>Waiting for a decision</h2>
    <div class="card"><div id="signups"><div class="empty">Loading…</div></div></div>
  </section>

  <section>
    <h2>Customers</h2>
    <div class="card"><div id="tenants"><div class="empty">Loading…</div></div></div>
  </section>

  <section>
    <h2>Plans</h2>
    <div class="card"><div id="plans"></div></div>
  </section>
</main>

<dialog id="secret">
  <h3 style="margin:0 0 8px;font-size:15px">Provisioned</h3>
  <p class="muted" style="margin:0 0 12px;font-size:13px">
    Shown once and stored nowhere. Send it to them now.
  </p>
  <div class="mono" id="secretBody" style="padding:12px;border:1px solid var(--line);border-radius:8px"></div>
  <div style="margin-top:14px;text-align:right"><button onclick="secret.close()">Done</button></div>
</dialog>

<script>
const api = (path, opts) => fetch('/api' + path, {
  headers: { 'content-type': 'application/json' }, ...opts,
}).then(async (res) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const pill = (v) => '<span class="pill ' + esc(v) + '">' + esc(v) + '</span>';
const day = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '—';

async function refresh() {
  try {
    const [overview, tenants, signups, plans] = await Promise.all([
      api('/overview'), api('/tenants'), api('/signups'), api('/plans'),
    ]);
    renderBanners(overview);
    renderStats(overview.counts);
    renderTenants(tenants);
    renderSignups(signups);
    renderPlans(plans);
  } catch (err) {
    document.getElementById('banners').innerHTML =
      '<div class="banner warn">' + esc(err.message) + '</div>';
  }
}

function renderBanners(o) {
  const out = [];
  if (o.openAccess) out.push('No CONTROL_OPERATOR_TOKEN is set, so this console is open to anyone who can reach it. Fine locally; set one before deploying.');
  if (!o.billingConfigured) out.push('Razorpay is not configured, so nobody can be charged. Trials and invoiced customers still work.');
  if (!o.signupsOpen) out.push('Public sign-up is closed. Requests can only arrive from someone you invite.');
  document.getElementById('banners').innerHTML =
    out.map((t) => '<div class="banner warn" style="margin-bottom:8px">' + esc(t) + '</div>').join('');
}

function renderStats(c) {
  const cells = [
    ['Customers', c.total], ['Active', c.active], ['Suspended', c.suspended],
    ['Failed', c.failed], ['Awaiting approval', c.pendingSignups],
  ];
  document.getElementById('stats').innerHTML = cells
    .map(([label, value]) => '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>').join('');
}

function renderTenants(rows) {
  if (!rows.length) {
    document.getElementById('tenants').innerHTML =
      '<div class="empty">No customers yet. Provision one with <span class="mono">npm run tenant -- create</span>.</div>';
    return;
  }
  document.getElementById('tenants').innerHTML =
    '<table><thead><tr><th>Customer</th><th>Status</th><th>Plan</th><th>Billing</th><th>Serves until</th><th>Trade</th><th></th></tr></thead><tbody>'
    + rows.map((t) => {
      const sub = t.subscription;
      const act = t.status === 'suspended'
        ? '<button class="primary" onclick="setStatus(\\'' + t.slug + '\\',\\'resume\\')">Resume</button>'
        : '<button onclick="setStatus(\\'' + t.slug + '\\',\\'suspend\\')">Suspend</button>';
      return '<tr><td><b>' + esc(t.name) + '</b><div class="muted mono">' + esc(t.slug) + '</div></td>'
        + '<td>' + pill(t.status) + '</td>'
        + '<td>' + esc(sub ? sub.planKey : t.plan) + '</td>'
        + '<td>' + (sub ? pill(sub.status) : '<span class="muted">—</span>') + '</td>'
        + '<td class="muted">' + day(sub && sub.servesUntil) + '</td>'
        + '<td class="muted">' + esc(t.templateKey) + '</td>'
        + '<td style="text-align:right">' + act + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function renderSignups(rows) {
  if (!rows.length) {
    document.getElementById('signups').innerHTML = '<div class="empty">Nothing waiting.</div>';
    return;
  }
  document.getElementById('signups').innerHTML =
    '<table><thead><tr><th>Business</th><th>Contact</th><th>Plan</th><th>Asked</th><th></th></tr></thead><tbody>'
    + rows.map((r) => '<tr><td><b>' + esc(r.name) + '</b><div class="muted mono">' + esc(r.slug) + '</div></td>'
      + '<td class="muted">' + esc(r.adminEmail) + '</td>'
      + '<td>' + esc(r.planKey) + '</td>'
      + '<td class="muted">' + day(r.createdAt) + '</td>'
      + '<td style="text-align:right;white-space:nowrap">'
      + '<button onclick="reject(\\'' + r.id + '\\')">Reject</button> '
      + '<button class="primary" onclick="approve(this,\\'' + r.id + '\\')">Approve</button>'
      + '</td></tr>').join('') + '</tbody></table>';
}

function renderPlans(plans) {
  document.getElementById('plans').innerHTML =
    '<table><thead><tr><th>Plan</th><th>Price</th><th>Seats</th><th>Grace</th><th>Description</th></tr></thead><tbody>'
    + plans.map((p) => '<tr><td><b>' + esc(p.label) + '</b></td><td>' + esc(p.price) + '/mo</td>'
      + '<td class="muted">' + p.seats + '</td>'
      + '<td class="muted">' + (p.graceDays ? p.graceDays + ' days' : '—') + '</td>'
      + '<td class="muted">' + esc(p.blurb) + '</td></tr>').join('') + '</tbody></table>';
}

async function setStatus(slug, action) {
  try { await api('/tenants/' + slug + '/' + action, { method:'POST' }); await refresh(); }
  catch (err) { alert(err.message); }
}

async function approve(button, id) {
  // Provisioning migrates and seeds a database; it takes tens of seconds and the
  // button must not look ignorable while it does.
  button.disabled = true;
  button.textContent = 'Provisioning…';
  try {
    const result = await api('/signups/' + id + '/approve', { method:'POST' });
    document.getElementById('secretBody').innerHTML =
      esc(result.adminEmail) + '<br>' + esc(result.adminPassword);
    document.getElementById('secret').showModal();
    await refresh();
  } catch (err) {
    alert(err.message);
    button.disabled = false;
    button.textContent = 'Approve';
  }
}

async function reject(id) {
  const note = prompt('Why? (optional)');
  if (note === null) return;
  try { await api('/signups/' + id + '/reject', { method:'POST', body: JSON.stringify({ note }) }); await refresh(); }
  catch (err) { alert(err.message); }
}

refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
