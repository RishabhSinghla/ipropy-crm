---
name: prove-it
description: Drive the real running CRM in a real browser and report pass / fail / couldn't tell before claiming a change works. Use after any change to a screen, a button, a form, navigation or anything a person clicks — and whenever a report is "it does not work" and the tests are green.
---

# Prove it in the browser

**A green test run is not a working feature.** On 24 September 2026 three bugs
were live with typecheck clean, 1,040 unit tests and 692 integration tests
green: Save & Next had never once rung the next person, the record header shoved
itself sideways the instant Call was pressed, and a record link lost its record
a heartbeat after arriving. All three took minutes to find in a browser and
were invisible to every other layer.

So: **anything a person clicks gets driven before it is called done.**

## The three answers, and why the third one matters

Report every check as one of:

* **pass** — you watched it work.
* **fail** — you watched it not work. Say what you saw.
* **couldn't tell** — you could not observe it from here.

**"Couldn't tell" is the one that earns its place.** Without it, anything
unobserved gets rounded up to a pass, which is exactly how a feature is
reported as finished when it is not. A phone that cannot be reached, a provider
that is not connected, a permission this container cannot grant — those are
"couldn't tell", never "pass".

## How

The stack has to be running:

```bash
pg_isready -h 127.0.0.1 -p 5432 || su postgres -c \
  "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pgdata -o '-p 5432 -c listen_addresses=127.0.0.1' -l /tmp/pg.log start"
(DATABASE_URL='postgresql://ipropy:ipropy@127.0.0.1:5432/ipropy' setsid nohup npm run dev > /tmp/dev.log 2>&1 &)
```

Then write a short script **in the repo root** (so `@playwright/test` resolves)
and delete it afterwards:

```js
import { openApp, report } from './e2e/drive.mjs';

const { browser, page, web, problems } = await openApp();
await page.goto(`${web}/leads`);
await page.waitForTimeout(4000);

const deck = page.getByTestId('call-deck');
report('the deck opens', await deck.isVisible().catch(() => false) ? 'pass' : 'fail');
report('anything the page complained about', problems.length ? 'fail' : 'pass', problems.join(' | '));
await browser.close();
```

`openApp()` handles the two things that cost a round trip every time: finding
the Chromium that is actually installed here (Playwright's own expectation is
a different build, and `chromium.launch()` alone fails), and the login field
being labelled *Email or mobile number* rather than *Email*.

## Rules that have already been paid for

* **Measure, do not eyeball.** "The header bounces" became a fact by reading
  the record name's `boundingBox()` before and after the click and comparing
  the numbers. A screenshot would have left it an opinion.
* **Read the database, not your own probe.** A check that said "0 calls
  logged" was the probe reading the wrong response shape; `psql` showed the row
  written correctly. When a probe disagrees with the product, suspect the probe.
* **Never assert on what is already in the database.** Create what you need, or
  the check reports the machine it ran on. Same rule as the e2e suite's unique
  markers.
* **A full page load hides a whole class of bug.** `page.goto()` re-boots the
  app, so it cannot show you anything that only breaks while clicking around.
  Click a real link when the question is about navigating.
* **The dev server hot-reloads on every file change**, which remounts the app
  and can make a broken thing look fixed. Do not edit source mid-check.
* **Keep anything worth keeping.** A check that proves a promise belongs in
  `e2e/` as a spec, not as a script you delete.

## Production is a different question

This drives **localhost**. `crm.ipropy.com` is blocked by this container's
egress proxy, and the read-only workflows in `.github/workflows/` are how
production gets asked anything. A change proved here is proved *here* — say so,
and say what is still waiting on a deploy.
