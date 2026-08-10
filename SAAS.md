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

## What does not exist yet

Roughly in the order it will hurt.

1. **Provisioning.** Creating a customer today means creating a Neon database,
   running migrations, seeding a template and setting an admin password by hand.
   This should become one command before the third customer, not the tenth.
2. **A place to keep the list of customers.** Which databases exist, which
   template each was seeded with, who owns it, what they pay. This is a small
   separate database — deliberately not one of the customer databases.
3. **Routing.** One deployment per customer is the honest starting point and
   needs nothing. One deployment serving many customers needs a connection pool
   per database *and* a registry cache per database — the two module-level
   `let`s above become maps keyed by customer. Do not do this before it is
   forced.
4. **Billing.** Razorpay for India. Nothing exists.
5. **Sign-up.** There is no self-serve anything. Users are created by an admin.
6. **WhatsApp at scale.** This is the underestimated one. Every customer needs
   their own WhatsApp Business number approved by Meta. Doing that without a
   human in the loop means Meta Embedded Signup and becoming a Tech Provider.
   WhatsApp is the heart of this product, so this is on the critical path.
7. **Becoming a data processor.** Holding another builder's leads makes iPropy
   legally responsible for other people's customers under the DPDP Act:
   contracts, breach notification, deletion on request. Worth an hour with a
   lawyer before the first paying customer, not after.
8. **Support.** One angry customer at 9pm is a person's job.

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

**Then — only if they pay and stay.** Provisioning command, customer registry,
Razorpay, Embedded Signup. In that order.

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
* **Migrations across many databases.** Forward-only and numbered, which is the
  right shape, but running them against 50 databases on deploy needs a runner
  and a way to report which one failed.
* **One shared media bucket or one per customer?** R2 charges nothing for
  egress; the isolation argument still applies to leaked object URLs.
* **How the scheduler behaves per customer.** In-process today, scanning up to
  5,000 records a tick. Fine for one desk, unclear at fifty.
