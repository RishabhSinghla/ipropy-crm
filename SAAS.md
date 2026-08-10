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

## What does not exist yet

Roughly in the order it will hurt.

1. **Routing.** One deployment per customer is the honest starting point and
   needs nothing. One deployment serving many customers needs a connection pool
   per database *and* a registry cache per database — the two module-level
   `let`s above become maps keyed by customer. Do not do this before it is
   forced.
2. **Billing.** Razorpay for India. Nothing exists.
3. **Sign-up.** There is no self-serve anything. Users are created by an admin.
4. **WhatsApp at scale.** This is the underestimated one. Every customer needs
   their own WhatsApp Business number approved by Meta. Doing that without a
   human in the loop means Meta Embedded Signup and becoming a Tech Provider.
   WhatsApp is the heart of this product, so this is on the critical path.
5. **Becoming a data processor.** Holding another builder's leads makes iPropy
   legally responsible for other people's customers under the DPDP Act:
   contracts, breach notification, deletion on request. Worth an hour with a
   lawyer before the first paying customer, not after.
6. **Support.** One angry customer at 9pm is a person's job.

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

**Then — only if they pay and stay.** Razorpay, then sign-up behind an approval,
then Embedded Signup. In that order. Provisioning and the customer registry are
done, so onboarding those first customers by hand is now one command rather than
an afternoon.

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
