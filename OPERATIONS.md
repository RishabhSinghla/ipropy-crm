# Running it in production

What is live, what is broken, and who deployed it. Read it before a deploy, and
when something on `crm.ipropy.com` is not behaving.

The rules that hold everywhere live in [`CLAUDE.md`](CLAUDE.md); this file is the detail.

---

## Going live — the state of it, 2026-09-01

* **The deploy gate is back on.** `autoDeployTrigger: checksPass` in both
  `render.yaml` and the Render dashboard, and **they must agree** — they
  disagreed for nine days and a blueprint sync would have silently reverted the
  dashboard. GitHub Actions minutes reset on the 1st; the first green CI run
  since 23 August was `9c4dbd5`.
* **Backups exist.** The nightly job had never once succeeded — every attempt
  failed in three seconds for want of minutes. Triggered by hand on 1 September
  and it completed every step, including **"Prove it restores"**, which restores
  the dump into a scratch database before uploading. All five R2 secrets were
  already present; it was only ever the minutes.
* **A deploy can fail where CI passes, and it is intermittent.** `9c4dbd5`
  passed all three checks and Render's build failed after 16 minutes; `d941460`,
  with the same setup and more code, succeeded. A clean
  `docker build --no-cache --platform linux/amd64` passes locally either way, so
  it is not the code — it is the free tier's build resources, and it will happen
  again. `node_modules` is 456 MB. **The symptom is a fix that never reaches
  production while everything looks green**, so check
  `gh api repos/OWNER/REPO/deployments` and its `/statuses` before assuming a
  deploy is merely slow. A retry usually works. The paid instance since 4 September should stop it, but
  that is an expectation rather than something observed yet.
* **A markdown-only commit CAN deploy, and this file used to say the opposite.**
  CI has `paths-ignore: '**/*.md'` so it does not run on a docs commit — that
  part was right. The conclusion drawn from it was wrong: `checksPass` waits for
  whatever check suites report on the commit, and it accepts **any** of them, not
  specifically CI. `a8eca56` on 4 September was CLAUDE.md alone, CI never ran, a
  scheduled *Production user audit* reported success on that SHA, and Render
  auto-deployed twenty-nine seconds later.
  So the gate is weaker than its name suggests: a workflow that has nothing to do
  with whether the code compiles can satisfy it. Worth knowing before trusting it
  to hold back a bad commit.
* **`gh run list` is not the whole story on why something deployed.** Render's
  own deploys page names the trigger, and the answers there are not always
  "Auto-Deploy": `fefa721` shows twice on 4 September, once as **Manual — by
  you** and once as **Compute plan updated**. A red CI run next to a deploy of
  the same commit looked like the gate failing, and it was neither.
* **Render is on the paid instance, and the sleeping is measured as gone.**
  `render.yaml` declares `plan: 0.5c-512mb` ($7/month), paid 4 September 2026;
  Render's deploys page records the changeover as a deploy triggered by "Compute
  plan updated". Verified by leaving production completely alone for 21 minutes
  and reading `/api/health`: uptime went 772s → 2032s, a difference of exactly
  1260s, so it ran continuously through a window the free tier would have slept
  in twice.
  Two earlier attempts to measure this concluded the opposite, both wrong, both
  because a deploy restarted the service mid-test and uptime resetting looks
  identical either way. **If you measure this again, stop pushing first**, and
  check the deploys page before reading a reset as a sleep.
  What it buys is not speed. The scheduler shares this process, so a sleeping
  instance meant no follow-up reminders, no lead escalation and no birthday
  messages overnight and at weekends — silently, with nothing logged.
* **The demo logins are gone from production.** `go-live:users` has been run: the
  4 September deploy seeded `users ✓ (1)`, a single real account. The twelve
  demo users sharing a password published in this repo no longer exist there.
* **Production answers on `crm.ipropy.com`**, with `ipropy-crm.onrender.com` still
  working alongside it. DNS is at **Wix**, not GoDaddy — GoDaddy is only the
  registrar, its DNS page is ignored, and a record typed there does nothing. The
  subdomain is one CNAME to `ipropy-crm.onrender.com`, and `APP_URL` must list
  every origin the app answers on or the browser is refused and **passkey sign-in
  breaks**, since the relying-party check reads that list.
* **Error reporting is live.** `GET /api/public/client-config` on production
  serves a real Sentry DSN, environment `production`, checked 13 September 2026.
  This line said a DSN had never been pasted in; it had. Still open: **no
  staging environment**, which remains the real gap — every change is proved
  against production or against a developer's laptop, and there is nothing in
  between.

### Two bugs the restored gate caught immediately

Both were mine, both invisible, and both had been live for a day or more.

* **And two phone specs reported the machine they ran on.** Both long-press a
  dashboard row, and every seeded list widget filters on `owner_id is_me` — so
  on a developer's database the admin owns plenty of leads left behind by
  previous runs, and on a fresh CI seed the demo leads belong to twelve demo
  users and the admin owns none. Green everywhere anybody looked, red on CI
  only, which reads as CI being flaky. `dashboardWithRecordRows` in
  `e2e/helpers.ts` creates the row it needs now. **A spec that depends on what
  is already in the database is a spec that reports the machine it runs on** —
  this is the same rule as the unique markers, applied to a widget's filter.
* **The mobile browser suite had been failing since 29 August.** A test helper
  was pointed at a `data-record-card` marker for phone-sized screens and the
  marker was never added to the app. Seven tests, every run, 30-second timeouts
  each. Not noticed because the suite was never run whole — only two spec files
  at a time. **`npx playwright test` with no arguments, or it does not count.**
* **Lead scoring failed on every lead for a day.** Removing the AI grade took
  `ai_grade = $3` out of an UPDATE and renumbered what followed, except `rating`,
  which stayed `$5` with four values bound. Postgres refuses the whole statement
  (42P18) and the caller is a workflow task that logs and carries on, so scores
  simply stopped moving. **This is rule 8, and it is now the fourth occurrence.**
  `tests/integration/leadScoringPersists.test.ts` runs it against a real
  database and asserts the row changed — a mocked `db.query` accepts any
  parameter list, and the SQL is a string, so neither typecheck nor a unit test
  can see it.

---

## Known open issues (details in PROJECT_HANDOVER.md §8)

* Deployed on Render from `render.yaml` (see `DEPLOYMENT.md`); every push to `main` redeploys.
  Production generates its own `JWT_SECRET` and sets `SEED_DEMO_DATA=false` — that gate must stay
  false, since the demo seed creates ~12 users sharing a password published in this repo. **Local
  dev still uses the committed defaults**, so never point a dev `.env` at the deployed database.
* **Scheduled backups of the deployed database are not on** — the
  launchd timer covers a developer's local Postgres only. The intended fix is Neon's own scheduled
  backups + instant restore (paid Launch plan), *not* a dump job in this repo; that was shipped once
  and deliberately removed. See `DEPLOYMENT.md` §7 before building anything here.
* Speech-to-text, email IMAP inbound, rollup fields and the Channel Partner portal shipped as
  graceful-degradation features — they need real credentials/keys to be exercised end-to-end.
* Dashboard drag-to-resize is wired (react-grid-layout on desktop, persisted via `saveDashboardLayout`).
* **AI answers now.** An OpenRouter key is saved and listing copy, reading photos and voiceover all
  work on production. Six of the eight model jobs pass their Test button.
* **Embed and rerank both work. What is throttling them is the free tier's fifty
  calls a day** — read off production on 16 September 2026 by
  `.github/workflows/ai-failures.yml`, which prints `ipy_ai_log.error` grouped
  by feature. Rerank: 157 successes to 10 failures, so the "unverified" note
  this line used to carry is answered. Embed: 386 successes to **4,480**
  failures, of which 4,318 read *"Rate limit exceeded: free-models-per-day. Add
  5 credits to unlock 1000 free model requests per day"*, with
  `X-RateLimit-Limit: 50`.

  So the id was never the problem, twice over — the old note's reasoning holds
  and is kept: **do not guess replacement ids.** The account is rationed, and
  the CRM was making a hundred and sixty embed attempts a day into a cap of
  fifty, each retried twice more. `media.ts` now holds a model whose day is
  spent until `X-RateLimit-Reset` says otherwise, and a daily ceiling ends the
  retry loop rather than feeding it (`tests/ai/quotaHold.test.ts`). **Five
  dollars of credit on OpenRouter raises the cap to a thousand a day**, and is
  the only thing standing between the search index and being current.
* **The model boxes offer real ids now** (`ai/modelCatalogue.ts`). Each one lists what OpenRouter
  serves for that job, free first, priced in rupees. Three rules encoded there: it stays free text
  so a retired list cannot lock somebody out; "Free" is claimed only for a `:free` id, because an
  empty pricing block means *billed elsewhere* — every video and rerank model has one; and any
  failure returns `[]` so the settings page never depends on a third party being up. Transcribe is
  deliberately absent — it does not go to OpenRouter.
* **Transcription goes to the speech-to-text integration, not OpenRouter** (migration `079`). It was
  wrong twice: wrong service, and JSON with base64 audio where every OpenAI-compatible endpoint
  wants multipart with a `file` part. **The key is in now and it works** — the `stt` row reads
  `connected` with a key against `api.groq.com`, and `whisper-large-v3-turbo` answered three calls
  out of three. This line used to say the row had no key; that was true when written and stopped
  being true without anything saying so. The five older `stt` failures in the log are from August,
  against an NVIDIA ASR id that does not exist.
* **The birthday greeting is gone, on the owner's instruction, and the reason it had to go is
  worth keeping.** 16 September 2026: *"get rid of this birthday thing forever, we won't be using
  it ever in this life in the CRM."* It was seeded with `date_of_birth is today`; the live row's
  condition list was **empty**, so a daily rule with a WhatsApp step matched every contact in the
  database. 20,006 messages queued on 13 September, 20,000 on the 16th, **40,515 waiting**, 20,209
  people holding two each, `run_count` 80,467. Nobody received one only because no WhatsApp
  Business account is connected — luck, not a safeguard.
  Removed from the seed and from production (`.github/workflows/remove-birthday-greeting.yml`);
  40,514 queued messages moved to `ipy_device_send_cleared` and deleted, the one legitimate
  hand-queued message left alone. **Do not reintroduce it.**
  The gap it came through is closed in `core/workflow/scheduler.ts`: `seed/pruneFieldRefs.ts`
  already refuses to let a workflow *lose* a condition and act on everybody, but skips one whose
  conditions are **already** empty, because there is nothing left to check. A scheduled workflow
  with no condition at all and a task that reaches a customer is now switched off rather than run
  (`tests/workflow/messagesEverybody.test.ts`). A scheduled rule that only changes the CRM's own
  data is untouched — releasing expired blocks legitimately sweeps everything.
* **The model settings were re-chosen on 16 September, and every id was checked before it was
  saved.** `scripts/set-ai-models.mjs` asks OpenRouter's catalogue **per modality** and refuses to
  write an id it cannot find — `/models` on its own is chat-only, so an embedding id checked
  against it finds nothing and reads as invented, which is how four working ids got written off
  here once. Live now:
  `ai_models.embed` = `baai/bge-m3` ($0.010/M, 8B, multilingual — the notes here are Hinglish and
  the old 1B free model was rationed to fifty calls a day); `ai_models.rerank` =
  `voyageai/rerank-2.5-lite` (free, 32K against the old 10K); `ai_models.copy` =
  `z-ai/glm-5.3-flash` ($0.100/M — it was blank, so listing copy fell back to the vision model);
  and the OpenRouter card's chat model = **`openrouter/auto`**, a router rather than a fixed id,
  because a router cannot be stranded by a retirement. `openrouter/free` is the proven fallback —
  124 calls, 124 successes in this CRM's own log.
  **Changing the embed model does not re-index within the hour, whatever this file
  used to say.** `refreshSemanticIndex` embedded one batch of 32 per visit, throttled to five
  minutes: 48,502 records is five days, and sixteen once the tick moved to fifteen minutes. A
  visit now keeps going for up to a minute of wall clock, stopping early on a short batch —
  which covers both "nothing left" and "the model is out of quota", since a held model embeds
  nothing. Measured before the change: 63 rows in 12 minutes.
* **Music sends only parameters its model accepts.** `modalities` and `audio` were on the request
  and are on no music model's `supported_parameters`, so the whole call was refused in 0.0s.
* **`xiaomi/mimo-v2.5` is not retired, and the 404s were being asked of the wrong provider.**
  OpenRouter's own catalogue lists MiMo-V2.5 at $0.119/$0.238 per million tokens, eighth-most-used
  model for image understanding. The 404s — *"models/xiaomi/mimo-v2.5 is not found for API version
  v1main"* — came from **Gemini**, because `complete()` handed an OpenRouter id to every provider in
  its chain. The same table shows the same model succeeding four times under its own name, which is
  what gave it away. Fixed by `jobModel()` and `CompleteOptions.provider`: a named id goes to the
  provider that serves it, the rest still follow with their own model.
  **This file said "retired" for an hour on 16 September. It was wrong, and the way it was wrong is
  the point** — a failure log that names the wrong model produces a confident wrong diagnosis.
* **Groq's chat defaults in `config.ts` are genuinely retired.** `llama-3.3-70b-versatile` and
  `llama-3.1-8b-instant` both answer "does not exist or you do not have access to it" from Groq
  itself, so every AI call spent a hop failing through Groq before Gemini answered. Defaults moved
  to `openai/gpt-oss-120b`, which is what `ai/models.ts` already names as Groq's primary and which
  OpenRouter lists as the fastest model it serves — **not verified against Groq's live API from
  here**, and cheap to be wrong about: a bad default 404s once and the chain carries on exactly as
  it does today. The id is a text box in Admin → Integrations either way. `complete()` also stands a
  provider down for ten minutes when its model reports itself gone, so a dead id costs one hop
  rather than every call.
* **`ipy_ai_log.model` used to name the wrong model on every failed row.** It fell back to whichever
  model the *settings* name, but `complete()` walks a chain, so a failed Groq attempt was filed
  under Gemini — 252 daily-digest failures against `gemini-flash-lite-latest` whose error text read
  "the model `llama-3.1-8b-instant` does not exist". Fixed; the attempt carries its own model into
  the log. **Any reading of that table from before 16 September 2026 is misattributed.**
* **The daily digest is not daily and was the CRM's largest token consumer** — 6,253 calls in thirty
  days, written afresh on every dashboard open, every AI-panel open and every morning brief, for two
  sentences about three numbers. Cached in `ai/assistant.ts` on the numbers themselves, so it is
  rewritten when a follow-up moves and not when somebody reopens a tab.
* **Semantic search is live.** Checked on production 11 September 2026: 355 rows in
  `ipy_embedding` across both leads and properties, written by
  `nvidia/nemotron-3-embed-1b:free` — the very id the note above records as failing — with the
  newest that morning. Whatever was wrong account-side has been sorted; **do not go hunting for a
  replacement id.** Rerank is verified too now, from the failure log rather than from anything it
  leaves behind: 157 answers to 10 refusals, the refusals being the same daily cap.

  The model settings live in `ipy_setting` under `ai_models.*`, not `ai.model*`, and
  `scripts/../.github/workflows/check-prod.yml` prints them along with the embedding count.
* **Site capture now runs end to end and is proved.** A property finished in the CRM reaches n8n,
  the worker names, finishes, cuts every shape, watermarks, builds the reel and the walkthrough,
  and the finished pictures come back onto the record. Run 4733 is the reference. What has *still*
  never happened is a real site visit: sunlight, one hand, no signal and EXIF offsets from a real
  camera are assumptions, not observations.
* **`properties.city` and `properties.project_name` were removed on purpose. Do not restore them,
  and do not protect them.** The owner's words: *"I deliberately removed those two fields."* He sells
  builder floors in one area, so a project grouping and a city filter are both noise on his own site.
  `/api/public/projects` and `/api/public/cities` correctly answer with nothing as a result, and the
  website no longer offers those sections — its header and footer ask the CRM what exists. Both were
  on `FIELDS_USED_IN_CODE` for one day, on the assumption the removal was an accident; that is
  reverted, and `tests/fieldsUsedInCode.test.ts` pins their absence so it does not come back.
* **Prices on the two published properties are `0`.** The public site reads that as "Price on
  request" rather than "₹0", and `propertyFacts` drops it so no reel prints ₹0 on its title card.
  Filling them in is still an admin job.
* **A dropdown option's label and its stored value are two different things, and they have
  drifted.** The label is what the screen shows; the value is what every record holds and what a
  couple of dozen string literals in the code match on (`status = 'Available'`). On 15 September
  25 options across 8 dropdowns stored something other than their label — Lead Status showed
  "Lead Won" on records storing `Contacted`. Seventeen were aligned by
  `npm run picklists:align`; the other eight are named in `VALUES_USED_IN_CODE` and were left
  alone, because renaming `property_status.Available` empties the public website's catalogue.
  **Do not align those.** The confusion they caused is fixed where it actually showed —
  `buildTimeline` resolves a picklist value to its label now, so the feed says what the screen
  says without any record being rewritten. `ipy_picklist_value_alignment` records what each
  aligned option used to store, in case any of it needs putting back.
* **The Team map's tile host is named twice, and both must agree.** `admin/TeamMap.tsx` picks the
  tile server and `applyAppSecurityPolicy` in `app.ts` decides whether the browser may load it.
  Changing one and not the other is a blank grey map whose only trace is the browser console:
  that is exactly what happened moving off CARTO, which now serves a tile stamped API KEY
  REQUIRED to anyone without a key. It is on OpenStreetMap's keyless tiles, and both files say so.
* **Social links in `social.links` were found by web search, not supplied by the business.** Two
  iPropy Instagram accounts exist. Treat them as unverified until someone confirms each one.
* Browser push works but **nobody has subscribed a device yet** — Settings → Alerts, per device.

### Verified security findings, 2026-08-30 — all closed

An external review raised eight. Each was checked against the code rather than
taken on trust, and **every one was true**. All are now fixed; this is kept as
the record of what was wrong and why the fixes are shaped as they are.

* **Public file routes served an uploaded mime type raw.** `applyFileSecurityHeaders`
  existed and ran only on the signed-in route. Four public byte-serving sites
  never called it, so a published SVG ran scripts on the CRM's own origin. Fixed;
  `tests/publicFileHeaders.test.ts` fails if a fifth route appears without it.
* **Telephony webhooks authenticated nobody.** Twilio now verifies a real
  `X-Twilio-Signature` HMAC over the **forwarded** URL — Render terminates TLS,
  so signing over `req.protocol`/`req.get('host')` refuses every genuine request
  and looks exactly like a wrong auth token. Others carry a per-provider shared
  secret. **The SSRF chain the review described does not exist** and was repeated
  here once before being checked: `analyseCallRecording` reads the `transcript`
  column and nothing else, and the only server-side fetches in
  `telephony/service.ts` go to the provider's own API on configured settings.
  Nothing anywhere downloads `recording_url`. What was real: anyone could rewrite
  call records, invent calls, and get an agent's phone number from `/incoming` —
  and a hostile URL stored on a call is a link a rep might click. All closed.
* **Lead webhooks failed open.** `if (key && provided !== key)` meant a blank key
  skipped the check entirely. Google and the portals both refuse when
  unconfigured now.
* **Three AI writes had no switch.** `ai_features.fill_fields_from_calls` and
  `ai_features.follow_up_from_calls`, both defaulting on. Lead scoring is left
  alone deliberately: a score that needs confirming is a task, not a score.
  `AI-ARCHITECTURE.md` used to claim nothing writes on its own and now lists
  what does.
* **A switched-off AI provider was still used.** Now `ai.use_disabled_providers`.
  **It defaults to ON on purpose** — `ai_openrouter` is `is_active = false` while
  holding the key, so defaulting it off would take every AI feature down to close
  a hole nobody is standing in. Switch it off after enabling the cards you want.
* **Refresh tokens were plaintext and never rotated.** Migration `083` hashes in
  place (nobody is signed out), rotation mints a replacement on each exchange,
  and a replay past the grace window revokes that user's whole session family.
  **The 60-second grace window is load-bearing**: two tabs hitting a 401 together
  present the same token, and without it rotation is a random logout generator.
  The client must store the returned `refreshToken` or the next refresh reads as
  theft.

**Still open and worth doing:** both tokens live in `localStorage`; there is no
prompt-injection or AI-quality eval suite; tokens are counted in `ipy_ai_log` and
never become rupees; the largest files (`RecordDetail.tsx` at 2,727 lines) want
splitting before a second developer arrives. (The CSP gap is closed: helmet's
global policy stays off because the media routes carry their own stricter one,
and the HTML document gets a strict hand-applied policy — `applyAppSecurityPolicy`
in `app.ts`, live in production, no inline script, no framing.)

---

---

## Two developers, one repo, and whose Claude made the commit

**20 September 2026, the owner:** *"I see my name everywhere why not other dev name
so we get to know this deployment to prod be his code or my code."*

Both developers work from their own Claude Code account, and every commit read
`Claude <noreply@anthropic.com>` — so the commit list, the deployments page and
`git log` all said `claude` for both of them, and nothing said whose change went live.

`CLAUDE_CODE_USER_EMAIL` is the one thing that genuinely differs between the two
sessions, so `.claude/helpers/git-identity.cjs` (a SessionStart hook) reads it and
sets `user.name` / `user.email` **repo-locally** — not globally, because this is the
only repo the two accounts share and a global change would follow a session into
somebody else's work. Adding a teammate is one line in its `PEOPLE` table; an account
nobody has added still gets a distinct name derived from its address rather than a
wrong one, because a commit attributed to the wrong person is worse than one
attributed to an email. The name keeps "(via Claude)" on purpose — a log that reads
as if a person typed every line misleads whoever reads it next.

**The GitHub "Verified" tick is given up, and it was a decision rather than an
oversight.** That badge checks the *committer* against the key that signed the
commit, and these are SSH-signed by the Claude account's key. Measured both ways
rather than assumed:

| what changed | GitHub links it to | verification |
|---|---|---|
| author **and** committer | the developer | `false` — `unknown_key` |
| author only | the developer | `true` — `valid` |

The second row is strictly better and is **not reachable automatically**: git has no
`committer.name` config key — it reads `GIT_COMMITTER_*` from the environment and
falls back to `user.*` — and the shells this tool runs are non-interactive and source
no profile, so there is nowhere to put those exports that every commit would read.
A `.bashrc` block was tried and did nothing. A name that is always right beat a tick
that appears only when somebody remembers a prefix. `main` does not require signed
commits (an unverified one pushed cleanly), so nothing breaks. To have both on one
commit: `GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com git commit …`

**What this does not fix, and cannot from here:** the *deployments* page says
"Deployed by RishabhSinghla" on every row regardless. That is Render's GitHub
integration acting under whoever authorised it, not anything this repo controls. The
commit each row links to now carries the right author, which is the readable half.

**And the bug this file caused on its way in, because it is the house pattern:** the
hook wrapped everything in a `try` that exited 0 silently, so when an edit removed the
name table it looked like it had run while every commit still said `Claude`. A hook is
the easiest place in the repo for a silent failure to hide. It says why it failed now.
