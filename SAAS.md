# Turning iPropy into a product other businesses pay for

The decision has been made: **one database per customer**, built alongside
iPropy's own use rather than instead of it. This file is the plan and, more
usefully, the list of things that are not yet true.

---

## Why database-per-customer, and not a `tenant_id` column

Today there is **no tenancy at all**. No table has a `tenant_id`. The metadata
registry and the integration settings are single module-level variables —
`let cache` in `core/metadata/registry.ts`, `let snapshot` in
`core/settings/integrations.ts`. One running server serves exactly one business.

That is a correct design for what was built, and it makes the choice easy:

* **A tenant column on every table** means reworking `core/query/builder.ts`,
  `core/permissions/` and both caches — the most load-bearing code in the
  system. One missed `WHERE tenant_id = …` and Builder A reads Builder B's
  leads. That is the mistake a CRM company does not survive.
* **A database per customer** leaves the engine alone. Isolation is a property
  of the connection string, not of every query anyone writes from now on. One
  customer's restore cannot touch another's. Neon is built for this pattern and
  bills per-database, so a small customer costs small money.

It is more expensive per customer and gets awkward in the high hundreds. That is
a good problem, several years away, and by then the revenue exists to pay for
solving it properly.

---

## What already carries its weight

* **The data model is data.** `db/seed/templates/` holds one file per trade;
  `realEstate.ts` is the model iPropy runs on. Adding a trade is a file and a
  line in the registry — no engine change. `validateTemplate()` refuses one that
  references fields nobody defined, which matters because seeding is additive:
  a bad template is fixed by restoring a backup, not by re-running.
* **Runtime customisation.** Modules, fields, layouts, views, picklists,
  workflows, roles and sharing rules are rows. A customer's admin reshapes their
  own CRM without a deploy, and `is_customised` / `ipy_field_tombstone` mean the
  next seed does not undo their work.
* **Per-customer configuration already exists.** `ipy_integration` holds each
  deployment's WhatsApp, AI, storage and telephony credentials, encrypted at
  rest. In a database-per-customer world that is per-customer for free.

---

## The control plane — built

The customer list and the provisioner exist. `packages/server/src/control/`,
driven by `npm run tenant`:

```bash
npm run tenant -- create --slug acme_realty --name "Acme Realty" \
                         --admin-email ops@acme.com \
                         --database-url postgres://…      # or let Neon make one
npm run tenant -- list
npm run tenant -- show --slug acme_realty
npm run tenant -- migrate                                 # every customer, in turn
npm run tenant -- suspend --slug acme_realty              # stops service, keeps the data
```

`create` writes the customer row, creates the database (Neon API, or one you
supply), migrates it, seeds the chosen trade, creates their admin with a
generated password, and prints that password once. Roughly ten seconds against
a local Postgres.

Things worth knowing:

* **`CONTROL_DATABASE_URL` must not equal `DATABASE_URL`.** The store refuses
  outright. The failure it prevents is one customer's database quietly holding
  every other customer's connection string.
* **Connection strings are encrypted at rest** with the same AES-256-GCM
  envelope as integration credentials, under a different key.
  `core/secretbox.ts` is the shared implementation — the salt is what separates
  the two purposes, and changing either makes the existing rows unreadable.
* **The customer row is written before the work starts**, so a provisioning run
  that dies halfway leaves a `failed` row and a history trail rather than an
  orphaned database nobody knows about.
* **`SEED_DEMO_DATA=false` is forced.** The demo users share a password
  published in this repository.
* **Migrate and seed run as child processes** with `DATABASE_URL` overridden.
  Both scripts resolve config once at import, and this is what points them at
  another database without teaching the whole app to hold two connections.
  Provisioning therefore runs from a machine with the repo checked out, not
  from the production container.
* **No Neon key is needed** to use any of this — pass `--database-url`. That is
  how the first customers should be onboarded anyway.

## The operator console — built

`npm run control` serves a screen at **http://localhost:4100/** — the customer
list, the sign-up queue, plans, and suspend/resume, all live.

Nothing to set up first. With `docker compose up -d db` already running, the
control plane creates its own database on first start, the same way `db:migrate`
does for the CRM. That convenience is development-only: in production
`CONTROL_DATABASE_URL` must be set explicitly, because a control plane that
quietly fell back to localhost would come up empty and look like every customer
had disappeared.

It is served by the control plane and **not** by the CRM on :5173, which is the
whole point: :5173 is one customer's deployment, and the console holds every
customer's connection string. Shipping it into the customer-facing bundle would
put the customer list inside every customer's app.

One page, no build step, no second React app — four tables one person looks at
do not justify a second bundler and a second deploy pipeline.

**Access is one shared token** (`CONTROL_OPERATOR_TOKEN`), not a login. That is
the honest shape for a one-person internal tool and it is worth naming its
limits: no per-person audit trail, and rotating it signs everyone out. When a
second person needs their own access, replace it. With no token set the console
is open — allowed **outside production only**, so that a developer can see their
own local console without a default token existing in the repository. In
production the API returns 503 until a token is set, and the console says so on
screen when it is running open.

Provisioning stays on the command line. `create` runs migrations and seeds a
database; the console can *approve* a queued sign-up, which is the same work
behind a human decision, but there is no button that invents a customer.

## Billing and sign-up — built

`npm run control` runs the webhook and sign-up listener; the rest is on the same
`npm run tenant` command line.

```bash
npm run tenant -- plans                 trial (free) · starter ₹2,499 · growth ₹5,999
npm run tenant -- billing-setup         create those plans at Razorpay, once
npm run tenant -- subscribe --slug acme --plan starter    # sends them a mandate link
npm run tenant -- invoice   --slug acme --plan starter --days 365   # paying outside the gateway
npm run tenant -- lapse                 suspend everyone whose paid time ran out — run daily
npm run tenant -- signups | approve --id … | reject --id …
```

**What an event means for service** lives in one pure function, `decide()` in
`billing.ts`, because it is the code that determines whether a builder can open
their leads tomorrow and it will run for the first time against real money. It
is generous in one direction and strict in the other:

| Event | Subscription | Their service |
|---|---|---|
| mandate authorised | active | works immediately, before any money moves |
| charge succeeded | active | +31 days, payment recorded |
| charge failed | past_due | **keeps working** for the plan's grace period |
| gateway gave up retrying | past_due | suspended |
| cancelled / completed | cancelled | suspended |
| anything else | unchanged | unchanged |

Suspension sets a status and nothing else. No data is touched, and `resume` is
immediate.

Things worth knowing:

* **The signature is checked against the raw bytes**, before parsing. Re-serialising
  parsed JSON changes whitespace and key order, the HMAC stops matching, and the
  temptation becomes to skip the check.
* **It fails closed.** No `RAZORPAY_WEBHOOK_SECRET` means no webhook is accepted.
  Accepting unsigned deliveries when unconfigured would be a public endpoint that
  suspends any customer whose slug you can guess.
* **Retries are expected, not exceptional.** Razorpay redelivers until it gets a
  2xx, so every event is claimed once in `ctl_webhook_event`. Verified: the same
  delivery twice extends the period once.
* **The grace period is enforced by `lapse`, not by the gateway.** `halted`
  arrives days late, after Razorpay finishes retrying. `lapse` is our own clock
  and should run daily. Customers marked `invoiced` are exempt.
* **Sign-up queues, it never provisions.** Every approval creates a database that
  costs money, so the public form records a request, rate-limited to 5 an hour,
  and off entirely unless `CONTROL_SIGNUPS_OPEN=true`. A human runs `approve`.

## What does not exist yet

Roughly in the order it will hurt.

1. **Routing.** One deployment per customer is the honest starting point and
   needs nothing. One deployment serving many customers needs a connection pool
   per database *and* a registry cache per database — the two module-level
   `let`s above become maps keyed by customer. Do not do this before it is
   forced.
2. **Nobody has run a rupee through it.** (The plumbing around it is now covered:
   `tests/integration/control.test.ts` provisions a real customer into a real database and drives
   the webhook shapes through it, and `controlApi.test.ts` covers who may reach the console. What
   remains unproven is Razorpay's own event names and payloads.) The gateway code is written and its
   logic is tested, but every test uses a signed fixture rather than Razorpay.
   Before a customer is charged: create the merchant account, run
   `billing-setup`, point a test-mode webhook at the control plane and put one
   real subscription through the whole cycle.
3. **WhatsApp at scale.** This is the underestimated one. Every customer needs
   their own WhatsApp Business number approved by Meta. Doing that without a
   human in the loop means Meta Embedded Signup and becoming a Tech Provider.
   WhatsApp is the heart of this product, so this is on the critical path.
4. **Becoming a data processor.** Holding another builder's leads makes iPropy
   legally responsible for other people's customers under the DPDP Act:
   contracts, breach notification, deletion on request. Worth an hour with a
   lawyer before the first paying customer, not after.
5. **Support.** One angry customer at 9pm is a person's job.

---

## The order

**Now — one customer, iPropy.** Everything above is theory until the CRM has
carried a real desk for a few months. Nobody buys a CRM whose maker does not use
it daily.

**Next — two or three friendly customers, by hand.** Separate Neon database,
separate Render service, invoiced manually. No billing code, no sign-up page, no
routing. This is the step that tells you what SaaS actually requires, and
whether anyone pays, before a line of it is built. Expect the answer to be
mostly "onboarding and support", not "features".

**Then — only if they pay and stay.** Meta Embedded Signup, and per-request
routing when one deployment each stops being practical. Provisioning, billing and
the sign-up queue are done, so onboarding a customer by hand is now two commands
rather than an afternoon.

**Then — trades beyond real estate.** One at a time, each with a customer
already waiting. The closest neighbours are construction, interiors and
furniture: big-ticket, long decision, site visits, quotations — the same shape
as property. Gyms and salons are a different product (bookings and memberships),
not a different field list, and should be refused politely until they are not.

---

## Open questions, honestly

* **A database that has been seeded cannot change trade.** `upsertModule` adds
  and updates but never removes, so seeding a second template leaves both sets
  of modules in place. Today the only cure is a restore. If customers are ever
  allowed to pick their own template at sign-up, this needs a real answer.
* **Migrations across many databases** now have a runner (`npm run tenant --
  migrate`, sequential, collecting failures) but nothing calls it on deploy yet.
  Wiring it into the deploy is what stops a schema change reaching the app
  before it reaches every customer's database.
* **One shared media bucket or one per customer?** R2 charges nothing for
  egress; the isolation argument still applies to leaked object URLs.
* **How the scheduler behaves per customer.** In-process today, scanning up to
  5,000 records a tick. Fine for one desk, unclear at fifty.
