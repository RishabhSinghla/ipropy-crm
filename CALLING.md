# The phone app, and calling

The Android and iPhone app, and everything about placing, ending and recording a
call. Read it before touching `packages/app/`, `packages/web/src/mobile/`,
telephony or the call console.

The rules that hold everywhere live in [`CLAUDE.md`](CLAUDE.md); this file is the detail.

---

## The phone app

`packages/app` is the CRM installed on Android and iPhone — the same React
bundle, wrapped in real native projects, with the phone's camera, location,
notifications and call log wired in. Read `packages/app/README.md` before
touching it.

Four rules that matter here:

* **It runs the metadata engine, it does not reimplement it.** Screens live in
  `packages/web/src/mobile/` and read the same modules, layouts and fields as
  the web. A hand-written native UI would freeze every screen into a release, so
  renaming a field would need a Play Store update. Anything added there must
  come from metadata, not from a constant.
* **The app is not a breakpoint.** `isNative` picks the mobile shell; a phone
  *browser* keeps the responsive web layout unchanged. This also keeps the
  phone-width Playwright specs pointing at what they were written against.
* **Two localhost origins in `allowedOrigins()` are load-bearing.**
  `https://localhost` (Android) and `capacitor://localhost` (iOS) are what a
  Capacitor webview stamps on its requests. They read like a development
  leftover; deleting either stops both apps at the login screen with a CORS
  error, on production only, with every test green.
  `tests/allowedOrigins.test.ts` fails if one goes.
* **The session is native storage, not a cookie.** A third-party cookie from a
  `capacitor://` origin is dropped by both platforms often enough that the team
  would be signed out hourly. The app uses the body path `/api/auth/refresh`
  already accepts.

**The app's screens open in a desktop browser with `?app=1`** — 24 September
2026, the owner: reviewing an app change meant deploy, pick up the phone, open
Chrome, sign in, download the APK, install it, find the screen, photograph it.
Seven steps between a change and an opinion about it, and the screens are
ordinary React either way. `crm.ipropy.com/?app=1` now mounts the app's own
shell in any browser, sticky until `?app=0`, with a banner carrying the way
out.

**It moves the shell and never `isNative`**, which is the property that makes
it safe and the reason this file's existing split earns its keep: `isNative`
means Capacitor is underneath and the camera, call log and dialler can be
called; `isInstalledApp` means somebody expects an app. Only the second is
overridden, so a preview **cannot** report that a native feature works. It is
opt-in and never inferred from width — the app is still not a breakpoint, and
the phone-width specs still test what they were written against.
`tests/appPreview.test.ts` pins all of it, including hostile storage.

**And the APK does not need downloading again for a screen change.** That is
what `lib/liveUpdate.ts` is for: the app asks the server what bundle it is
serving and swaps to it on the next launch. Reopening the app is the update.
A new APK is needed only when the **native** half moves — a plugin, a
permission, the call-log engine, the icon — which is rare, and which
*This phone's app* in Settings is what says.

The standalone `companion-android/` call-sync app is folded in. Its engine came
across unchanged except for one fix worth knowing: **all three call-log queries
appended a row cap to the sort order**, which from Android 11 the call-log
provider refuses outright (`Invalid token LIMIT`). Both callers catch and carry
on, so the symptom is a handset that pairs, reports itself healthy and uploads
nothing, ever — which is the likeliest explanation for the three handsets paired
since August that never synced. `queryCalls` uses `QUERY_ARG_LIMIT` now. The
second half of the same bug was quieter: `currentHighestId` returned 0 on
failure, indistinguishable from an empty call log, and 0 means *start from the
beginning* — so fixing the read alone would have uploaded every rep's personal
call history. It returns null on failure and pairing refuses rather than guesses.

Building needs **JDK 21** (not 17 — Capacitor 8 plugins declare a Java 21
toolchain and Gradle will not substitute another).

**iPhone: Apple's toolchain runs on macOS and nowhere else, so every road
needs a Mac somewhere. What differs is whose, and what it can produce:**

| road | needs | produces |
|---|---|---|
| **CI compile** (`build-the-ios-app.yml`) | nothing — a GitHub macOS runner | proof it builds; nothing installable |
| Xcode on the owner's Mac | Xcode (~15 GB) | Simulator, or 7 days on his own iPhone |
| **TestFlight** | **$99/year**, plus CI | the app on the whole team's iPhones |

**The owner has refused Xcode** (24 September 2026 — an Air, and it would
"hang and heat my mac"), and refused the Home Screen install as an answer. So
the only road left to a real app on a real iPhone is the paid account, and
that is worth stating as a cost rather than worked around: a signing
certificate comes from a paid Developer account, or from Xcode handing a free
Apple ID a seven-day one. **There is no third door.** Anything claiming
otherwise (sideloading tools, re-signers) still needs a computer running
software every seven days.

What is free and was never done: **the project had never been compiled, by
anybody, anywhere.** `build-the-ios-app.yml` does that on a macOS runner with
`CODE_SIGNING_ALLOWED=NO` against the simulator SDK — no certificate, no
account. It proves the Swift builds, the plugins link and the bundle copies
in. It is `workflow_dispatch` only because **macOS runners bill at ten times
Linux**, and this repository ran its allowance out once before, in August,
stopping every deploy for nine days.

**Expo is the wrong tool and the question comes up because the names sound
alike.** Expo builds React Native, where the UI is native components; this app
is a React *web* bundle in a Capacitor webview, which is the entire reason the
screens update themselves from production and the metadata engine is not
reimplemented. Moving to Expo means rewriting every screen and losing that.

**Android Studio is not required and never was — the SDK is.** This container
has JDK 21 and no Android SDK, and its egress proxy refuses
`dl.google.com`, so it cannot get one. A GitHub runner has both,
which makes `.github/workflows/build-the-app.yml` the way to build the app
without anybody's laptop: web bundle, `cap sync`, `assembleRelease`, the
version read back out of the APK, and a check that `placeCall` and
`CALL_PHONE` are actually inside the build before it is published — their
absence is invisible until a rep presses Call.

**The signing key is the whole blocker, and on 21 September it stopped a
release the owner had asked for.** The end-a-call work needs a new APK; the
runner refuses to build one without the key that signed what is on the
handsets; that key exists on one laptop and nowhere else — not in the repo,
not in its history, not in any session's container (all three were checked
rather than assumed). This container cannot make a replacement either: it has
`keytool`, and creating a signing key is refused here as a secret-store write,
which is the right refusal. **So an app release cannot be completed from a
Claude session alone until the key is in the repository's Actions secrets.**
`packages/app/scripts/share-release-key.sh` is one command, run on the machine
that holds the key, that puts it there through `gh secret set` — nothing is
printed, pasted or typed. Until somebody runs it, every app change is written,
tested and unreachable, which is the state the phones have been in since
1.0.0. And note `dl.google.com` is refused by this container's egress proxy,
re-checked the same day, so building locally is not a way round it.

**The one thing a runner cannot invent is the signing key.** Android refuses
an update signed by a different key from the version already on the phone, and
2.1.0 was signed on a developer's Mac, so the workflow needs that same
keystore as `ANDROID_KEYSTORE_BASE64` plus its three passwords. It refuses
rather than falling back to the debug key, for the reason `build.gradle`
already states: a debug-signed release installs perfectly and then blocks
every properly signed update after it, months later, on somebody else's phone.

**But "it must be the same key or the team cannot update" was already false
when that message was written, and the message is what blocked the next
release.** Read out of the two published APKs on 21 September 2026 with
`packages/app/scripts/which-key-signed-it.py` — no SDK needed, it reads the
APK Signing Block directly:

| build | signer | key made |
|---|---|---|
| 1.0.0, 12 Sep, what most handsets run | `A2:55:AD:0D…` | 12 Sep 05:37 GMT |
| 2.1.0, 20 Sep, on the download page | `D6:CD:55:3B…` | 20 Sep 11:07 GMT |

**Two different keys, same subject, and no rotation lineage** — both APKs
carry a v2 block only, no v3.1, so this was a clean break rather than a
rotation. Somebody re-ran `make-release-key.sh` on 20 September. The
consequence is the part that matters: **every phone still on 1.0.0 has to
uninstall before it can take 2.1.0 or anything after it, whichever key is
used.** Preserving the Mac's key saves exactly the phones that already have
2.1.0 — which on 21 September was one handset, the one being tested on.

So the real choice is 3 uninstalls versus 4, not "nobody" versus "everybody",
and `build-the-app.yml` says so at the point of failure now instead of
repeating a rule that had already been broken. It also offers the second road
(`make_new_key`), which generates a keystore on the runner and **saves it to
the repository's own secrets before building with it**. A key made and then
lost would leave an app nobody could ever update, so the write token is
checked before `keytool` runs rather than after.

**That second road is blocked too, and the reason is a note in this file that
was wrong.** It said the `SECRET_WRITE_TOKEN` PAT is one `create-api-key.yml`
"already uses". That workflow *reads* it and carries a branch for its absence —
which is the branch it has always taken. Run 4 of `build-the-app.yml` on
21 September printed `GH_TOKEN:` empty: **the secret does not exist.** Checking
a name appears in a workflow is not checking the secret is set, and the
difference cost a second blocked release.

**And `secrets` may not be used in a step's `if:`.** It is absent from
GitHub's context-availability table for `steps.if`, and a workflow that tries
fails to *parse* — so it cannot be dispatched at all, and the error names a
line rather than the rule. The question is asked once in a job-level `env`
(which may read secrets) and the steps test that.

**The lesson is the one this repo keeps re-learning in a new costume:** a
refusal message is a claim about the world, and it goes stale like any other.
This one was written on 20 September, was true for about four hours, and was
still being quoted as a blocker a day later.

**The team was about to be told the wrong thing by two of the CRM's own
screens, and that was the one thing fixable without a human.** Both the
download card and the in-app *This phone's app* card said the new build
installs "over the top". Across the key change it does not: Android answers
**"App not installed"** and gives no reason, so a rep updating a handset would
have reported the app as broken. `needsUninstallFirst` in `lib/appVersion.ts`
holds the boundary, read off the published APKs rather than assumed — **1.0.0
is on the old key; 2.0.0 and 2.1.0 share the new one** — so only the phones
that must uninstall are told to, and an unreadable version counts as yes for
the same reason it counts as behind. It is in the web bundle, which every
installed handset updates itself from, so it needed no key, no token and
nobody. `tests/appNeedsUninstall.test.ts` pins it.

**And the note that said every installed copy predates `placeCall` is out of
date.** The APK published on 20 September 2026 — 2.1.0, versionCode 3 —
**contains it**, along with the `CALL_PHONE` permission and the pending-dial
poll. Read out of the published APK itself (`unzip`, then `grep -a` the dex and
`strings -el` the binary manifest), not assumed.

**The phones are the half nobody had checked, and `ipy_device.app_version`
records it.** Read off production the same day
(`.github/workflows/which-app-version.yml`, read-only): **every handset that
has ever synced reports `1.0.0`**, against 2.1.0 on the download page. Fifteen
paired rows, three of them ever syncing; the Redmi Note 7 Pro uploaded 63
calls at 14:02 that afternoon, so pairing and call sync work perfectly on
1.0.0 — it is only the dialling half that is missing. Dial instructions now
stand at **162, none collected, none reporting how**.

So the thing standing between a desk Call and a ringing phone is **a reinstall
on each handset, not a rebuild and not Android Studio**. Nothing in this repo
can do it: somebody has to open the CRM on each phone and install 2.1.0. Until
then the fixes above are correct and unreachable, which is its own trap —
`app_version` is the field that tells you which.

---

---

## Pressing Call at a desk rings the rep's own phone

**18 September 2026, the owner's report:** clicking Call on a Mac showed Chrome's
*"Open Phone? https://crm.ipropy.com wants to open this application"* — the `tel:`
hand-off asking which app should take the number. A laptop cannot place a phone call, so
the CRM asks the paired handset instead.

* `POST /api/telephony/dial` queues a `dial` command on `ipy_device_command` (migration
  `157`) against the signed-in user's most recently synced active phone, and emits
  `device:dial` to `user:<id>`. Picking "most recent" is safe **here and nowhere else** —
  every device considered belongs to the same person, so the worst case is their spare
  handset. The WhatsApp rebuild carries the same shape as a warning, because there the
  accounts were different people's.
* **The command expires in ninety seconds** (`expires_at`, swept on the next queue). A
  phone back from a flat battery must never ring a customer for a button pressed the
  night before. That rule is the reason this is a queue with a clock and not a push.
* The app's own webview holds the socket, so the instruction arrives in the same second
  and `CallSync.placeCall` fires `ACTION_CALL` — `CALL_PHONE` is asked for the first time
  somebody presses Call, never at pairing. The result is posted back with the **device**
  token, which only the native side holds; a browser session cannot speak for a handset.
* **The CRM waits for that result before claiming anything.** Five seconds of polling
  `GET /api/telephony/dial/:id`; anything other than `done` says so and falls back to the
  desk hand-off. The two ordinary ways it goes quiet are a phone that is off and **an app
  one version behind that has never heard of `placeCall`** — which is every installed
  copy until somebody rebuilds and re-installs it.
* **The Android half is written and has never been compiled here.** There is a JDK but no
  Android SDK in this container, so `placeCall`, the manifest permission and the result
  post are unproven against a real handset. `tests/integration/dialFromTheCrm.test.ts`
  covers the server end — queue, expiry, the phone closing a command, and one handset
  being unable to close another's.
* **And the desk fallback froze the page, which is how it was found.** When the paired
  phone does not take the call the CRM hands the number to the browser, and a browser with
  no application registered for `tel:` starts that navigation, aborts it, and from then on
  delivers **no mouse events to the page at all** — so the outcome form that has just
  opened cannot be saved and every button on the record is dead until a reload. A hidden
  iframe behaves identically; it is the navigation, not where it starts. `dial()` hands it
  to a new tab on the web now and keeps `location.href` for the app, where a webview always
  has a dialler. The symptom to recognise: a click that Playwright reports as successful
  while no `pointerdown` or `click` reaches the document, and a programmatic
  `dispatchEvent('click')` on the same button working perfectly. `e2e/callOutcome.spec.ts`
  had been failing on exactly this since the dial feature landed.

### It had never once worked, and the database said so

**20 September 2026, the owner: "Call Not going."** Read off production rather than
guessed (`.github/workflows/why-the-phone-did-not-ring.yml`, read-only): **130 dial
instructions, 122 expired and 8 still queued, `delivered_at` null on every single row.**
Not one has ever been collected by a phone, by anybody, since the feature landed. Pairing
itself is fine — two handsets uploaded calls the same week.

The cause is one line of design that nothing wrote down: **the instruction reaches the
phone only over the app's own socket, into its webview** (`device:dial` in
`lib/realtime.ts`). There is no endpoint a phone polls for waiting commands. So the app
has to be **open and signed in** for a desk Call to ring it — and even then, every
installed copy predates `placeCall`, the plugin call fails, and nothing closes the
command out.

Two changes, both of which work with the app exactly as it is installed today:

* **The webview hands the number to the phone's own dialler when the plugin cannot.**
  A webview always has one, so an old build now dials with the digits filled in and the
  rep presses the green button. Without this the instruction was simply never collected.
* **The app closes its own command through the session** (`POST /api/telephony/dial/:id/result`),
  because the device-token route needs a credential only the native plugin holds. A
  person may close their own dial instruction and nobody else's. The desk is told
  *which* happened — `via: 'app'` rang on its own, `via: 'dialler'` needs the green
  button — and says so, rather than claiming a call that is still waiting for a tap.

**The failure message names the thing a rep can act on**: open the app on the phone. It
used to say the app needed updating, which is true and is not something a rep can do.

### Is the phone reachable, and has it allowed anything?

Two questions the CRM could not answer about a handset, so "Call not going" had no
diagnosis on either side of it.

**Reachability** (migration `165`, `lib/phoneStatus.ts`, `components/PhoneStatus.tsx`).
`last_sync_at` was the only fact there was and **it is not liveness**: `SyncWorker` wakes
every fifteen minutes and returns *without contacting the CRM* when there are no new
calls, so a perfectly healthy phone on a quiet morning looks identical to one switched
off. `ipy_device` now carries `last_seen_at` (stamped by `authenticateDevice`, so every
device-token request counts) and `app_open_at` (a 60-second heartbeat from
`lib/appPresence.ts` while the app is open and visible). Settings → Phones reads them as
**App open · Idle · Offline · Never**, beside how the last Call ended — `expired` being
the exact failure the owner kept meeting. Only "App open" means pressing Call will ring
it, because the instruction travels over the app's own connection.

**The phone now looks for a waiting call on its own timer** (`lib/dialWatch.ts`, every
five seconds while visible). `/dial/pending` existed and **nothing on a schedule ever
called it** — only the socket event and a reconnect did, so a phone whose socket was
asleep collected nothing, for ever. `takePendingDial` lives in that file and is imported
by `realtime.ts` rather than copied: the socket is the fast path, the timer is the one
that works when there is no socket at all, and two copies of the claim would eventually
disagree about how a command is closed out.

**The claim is one statement** — `FOR UPDATE SKIP LOCKED` inside a CTE that updates in
the same breath — because the socket and the timer both look, and both being handed the
same command rings the customer twice.
`tests/integration/thePhoneIsReachable.test.ts` races two callers at it. **It has to
clear the account's other queued commands first**: another suite dialling from the same
admin leaves a row behind, two callers then each legitimately claim a *different*
command, and the test fails while the thing it is about works perfectly. Same rule as the
dashboard specs — a test that depends on what is already in the database reports the
machine it ran on.

### Android asks for nothing at install time

**20 September 2026, the owner:** *"if APK need any permission please ask before install
app, make the working structure."*

Installing an APK grants it **nothing**. Every permission is asked for later, from inside
the app, by the code that needs it — so a handset can be installed, signed into, and
still unable to ring anybody, with nothing on screen saying which answer is missing. That
is precisely what production was doing.

`lib/phonePermissions.ts` is the checklist as **data** (pure, node-tested) and
`components/PhoneSetup.tsx` draws it: pair, Phone, Call logs, Notifications, and Location
only once somebody has switched location on. It is on the app's **You** tab whenever
something required is outstanding — not only in Settings, because a rep who has just
installed the app has no reason to go hunting for a permission nobody told them about —
and on the browser's download card as *what the phone will ask you to allow*, before
anybody installs it.

Three rules in it:

* **A row is redrawn from the plugin's own answer, never from the fact a button was
  pressed.** After two refusals Android stops showing the dialog at all and answers
  "denied" without one; a tick there is a lie the rep then acts on.
* **"While using the app" is not location granted.** `backgroundLocationGranted` is the
  test, because foreground-only reports nothing once the screen goes off — a map that
  quietly stops moving rather than one that says it is off. Android will not grant "all
  the time" from a pop-up either, so that row asks for what it can and then opens the
  app's own settings page.
* **It lives in the web bundle**, which is the half that updates itself from production.
  So it reaches every installed handset with no APK rebuild — which is just as well,
  since this container has a JDK and no Android SDK.

**Still true and still not buildable here:** `placeCall` itself — the ACTION_CALL path
that needs no tap — is Android code that has never been compiled, because this container
has a JDK and no Android SDK.

What is **not** possible, whatever a CRM claims: hearing a call as it happens. Android
closed third-party call recording in Android 10 and no permission reopens it. What works
is what `RecordingFinder` already does — the OEM recorder's file, read from a folder the
rep grants once, uploaded **after** the call ends and matched on the last ten digits plus
a time window. The player with play/pause is already in the timeline and the Calls tab.

### "Phone call was not confirmed" about a call that rang

**20 September 2026, the owner, against a record showing a one-minute outbound
call he had just finished:** *"cool, the call is landed, but this msg coming
unnecessarily."*

The desk watched `GET /api/telephony/dial/:id` for five seconds and accepted
**only `done`**. But the phone collects the instruction in well under a second
(`delivered`) and closes it out only once the rep has taken the handset out of
their pocket and pressed the green button — which is a minute later, not five
seconds. So the ordinary successful path ended in a red toast telling somebody
to go and install the app, while the call they had just made was already in the
timeline.

`delivered` is now the answer to *"did it reach the phone"*, which is the only
question the desk can honestly ask in those five seconds; `done` still says
*how* when it arrives in time. A red message is kept for the two states that
really are failures — `expired` (nothing ever collected it) and `failed`.
`tests/integration/thePhoneIsReachable.test.ts` pins that a claimed command
reads `delivered` with no `via` yet, which is the state that was being called a
failure.

**The general shape, and it has now cost two reports:** a screen that waits a
fixed few seconds for somebody else's slowest step will call the normal path
broken. Wait for the fact you can actually establish in that time.

---

## The calling system, and what it still needs

**20 September 2026, the owner sent a twenty-point specification** for a NeoDove-style
Android calling app wired into this CRM. His own §20 says: inspect what exists, reuse it,
do not rebuild working functionality, and build in phases. So the first answer is an
inventory, because **most of the server half already exists** and was built over several
sessions:

| His ask | What is already here |
|---|---|
| §1 dialler, §3 mobile→web sync | `packages/app` + `CallSyncPlugin.kt`: pairing, call-log upload, `POST /api/device/calls` with dedupe |
| §2 click-to-call | `POST /api/telephony/dial` → socket + `/dial/pending` poll → the phone's dialler |
| §4 contact matching | `matchContact.ts`, last ten digits, refuses to choose between two people |
| §6 timeline | calls already merge into `buildTimeline` |
| §7 recording | `POST /api/device/recordings`, signed playback, OEM-recorder file only |
| §8 post-call screen | `CallDispositionProvider` on the web, `/calls/:id/disposition`, follow-up written through `followUp.ts` |
| §10 agents/devices | `ipy_device`, per-user tokens, pairing screen |
| §15 security | JWT + refresh rotation, device tokens, capability gates, signed recording URLs |

**Added 20 September:**

* **`GET /api/telephony/lookup?phone=`** (§4, §9, §17) — the caller card. One question, one
  answer, for both the phone (before it rings) and the CRM (after a call ends). It reads
  the record **as the person asking**, so a rep outside a lead's scope is told the number
  belongs to somebody and *whose* — enough to pass it on, nothing about the customer. It
  never guesses between two people; `matchContact` already refuses, and the screen offers
  the candidates.
* **A Calls page** (§5) — every call with direction, picked-up-or-not, outcome, date range
  and "only mine", the record link, and a recording that loads only when somebody presses
  play. Nothing re-derives a call: it is the same endpoint the record's Calls tab reads.
* **The list's filters and its count.** The count rides in **`X-Total-Count`, not in a
  wrapped body** — this endpoint answers a bare array, an integration test pins that in
  those words, and changing the shape to add one number broke four tests before the header
  was used instead. A response shape with readers is a contract.

**What cannot be built here, and it is not a scheduling problem.** Everything in §1, §11,
§12 and most of §16 — the default dialler, `InCallService`, `ROLE_DIALER`,
`CallScreeningService`, multi-SIM, the Room offline queue, FCM — is Android code, and this
container has a JDK and **no Android SDK**. It cannot be compiled, let alone run on a
handset. The repo already carries the cost of ignoring that: `placeCall` was written here,
never compiled, and every installed copy of the app still cannot place a call — 130 dial
instructions, none ever collected. **Writing more unproven Android code makes that worse,
not better.** That half needs a machine with Android Studio and a real phone.

What *is* worth doing from here, in his order: the server and web halves of each phase —
the lookup and the Calls list (done), then the live-call panel and the call reports, which
need the phone to report state and are therefore only worth building once something can.

---

## The call side, walked as a paired handset — 20 September 2026

Same method as the WhatsApp walk: a real handset paired against the running
stack, and every route it uses driven for real. **What the installed app can do
today works**, and three faults came out of the parts nobody had exercised.

What was proved end to end, against a live server: pairing and `/ping`; a call
log uploaded, both directions read correctly from Android's `type`, both
matched to a contact on the last ten digits; **a replay of the same
`externalId` deduped** (`created: 0, duplicates: 1`); a recording uploaded from
the phone, stored, and played back with range support; a dial queued, expiring
in ninety seconds, and closed by the handset — and **only** by that handset.

* **A call recording was served without the file security headers.** The route
  set `Content-Type` and `nosniff` and stopped there: no Content-Disposition,
  no CSP, with a mime type that arrived with an upload. This is the same
  omission the public file routes produced once, and the repo already has a
  rule about it. `applyFileSecurityHeaders` is called **before the range
  branch**, because a 206 returns bytes too and the seeking player is the one
  that asks. Pinned in `tests/publicFileHeaders.test.ts`, which now also
  asserts that order.
* **"The desk is told which happened" was not true, and this file said it was.**
  `via: 'app'` versus `via: 'dialler'` is the difference between a phone that
  is ringing and a phone with the number typed in waiting for a green button.
  The session route recorded it; the **device-token route — the native
  plugin's, so the good path — did not**, and `phoneTookIt` on the desk threw
  the field away and returned a boolean. So a rep was told "Ringing from your
  phone" either way. Both ends fixed;
  `tests/integration/dialFromTheCrm.test.ts` pins the plugin path saying
  `app`.
* **`POST /api/device/calls` takes `entries`, not `calls`.** Not a bug — worth
  writing down because the obvious guess answers a validation error and looks
  like a broken endpoint.

**What is still not provable from here, and is the honest limit:** `placeCall`
itself is Android code and this container has a JDK and no Android SDK, so the
native path has never been compiled. Everything above tests the server's half
of it. And the installed copies of the app still predate `placeCall`, so until
somebody rebuilds and re-installs, the dialler fallback is the *only* path a
desk Call can take — which is exactly why the `via` fix matters now rather than
later.

---

## "The app is not working" — what a phone can and cannot tell you

**20 September 2026, the owner: "please update android app also, app not working."**
No screenshot, and from a phone there was nothing to read. So the first job was
to make the invisible visible rather than to change anything.

**Everything the app asks production for is healthy**, read by
`.github/workflows/what-the-app-sees.yml` (read-only, public endpoints only):
the server answers, **both webview origins are accepted** (`https://localhost`
and `capacitor://localhost` — the CORS trap this file already warns about is
not the cause), a bundle is on offer, and `bundle.zip` really is a zip, 878 KB.
An APK is published and downloads: **2.1.0, built 13:41 UTC that day** by the
other developer's session.

**The published APK was opened and read rather than trusted.** `placeCall` is
in `classes2.dex`, and the binary manifest declares `CALL_PHONE` and
`READ_CALL_LOG`. So installing 2.1.0 is a real fix for the desk-Call path, not
a hope — that had never been checked before. The manifest is **UTF-16 binary
XML**: `grep CALL_PHONE AndroidManifest.xml` answers "not found" on an APK that
declares it, which is how a wrong conclusion gets drawn in one line. Read the
bytes (`perm.encode('utf-16-le') in data`), never a plain grep.

**The app is two halves and they update two different ways.** The **screens**
are the same React bundle the website serves and update themselves on the next
launch (`lib/liveUpdate.ts` + `/api/public/app/bundle`), so they are nearly
always current. The **native half** — the dialler, the call-log reader — is
frozen in the installed APK. Every handset in this business had a build that
predates `placeCall`, and **nothing on the phone said so**: `callSyncStatus()`
has carried `BuildConfig.VERSION_NAME` all along and no screen showed it.

So Settings, *inside the app only*, now says which build this phone is running,
what the latest is, and offers Update when it is behind (`ThisPhonesApp`, with
`lib/appVersion.ts` deciding). **An unreadable version counts as behind**, which
is the case that matters rather than an edge: a build too old to name itself is
by definition older than the one on offer, and answering "up to date" there
would hide exactly the phones that cannot place a call
(`tests/appVersion.test.ts`).

**What remains unknown, and was said plainly rather than guessed:** which of the
several possible faults the owner actually met. A phone with no version on
screen and no error message cannot be diagnosed from here, which is the whole
reason that card now exists.

---

## The call console

**21 September 2026, the owner, with a design of his own:** *"can you redesign
this UI/UX of click-to-call popup form and next-to-call dialler with fully
functional features, editable key values as per given screenshot."* What it
replaced asked for an outcome, a duration and a date.

`components/CallConsole.tsx` draws it; `lib/callConsole.ts` holds the decisions,
pure, so a `node` test can read them without dragging the store in. The console
renders inside the ordinary `Modal` — which gained an optional `header` and
`bodyClassName` for it, rather than growing a second focus trap, Escape handler
and scroll lock to keep in step.

* **No screen names a field.** The key values in the bar under the header are
  whatever Admin → Split View says this module's header shows, through the same
  `useRecordPanes` the record page and the chat pane read, and they are edited
  where they stand with `EditableField`. So Budget appearing there is an admin's
  decision, made once, and every screen agrees.
* **The outcome cards are the admin's picklist**, through `useCallDispositions`,
  never a list of six written here. `outcomeCard` gives each value an icon, a
  hint and a corner chip, and **reads an outcome nobody has described by its
  words** rather than dropping it — an admin who adds "Site Visit Fixed" gets a
  card, because the alternative is a rep who cannot record what happened.
  `aria-label` is the outcome itself: without it a screen reader announces the
  chip first ("Priority Interested High priority buyer").
* **The chip and the schedule cannot disagree.** "In 2 hours" is printed from
  `followUpInHours` on the same card the save reads, so a card promising two
  hours and a follow-up landing tomorrow is not expressible. It **never
  overwrites a date already in the future** — the header lets a rep book
  Saturday's site visit mid-call, and a card quietly replacing it is the bug
  that would follow.
* **Mute, hold and End are drawn and dead on purpose.** Android only lets the
  handset's **default phone app** touch a call that is already running; iPropy
  hands a number to the dialler and reads the call log afterwards. A red End
  button that ends nothing is the exact failure this repo keeps writing down, so
  they carry the reason in their `title` and light up on their own when
  `mayControlLiveCall` says the app can (it cannot today, and that needs the
  `InCallService`/`ROLE_DIALER` work, which is Android code and needs an SDK).
  The e2e spec asserts they are **disabled**, so nobody quietly enables one.
* **The timer counts what can honestly be counted** — time since Call was
  pressed, not time the two people have been talking, which no browser knows.
* **Hot / Warm / Cold is on the call, not the record.** The obvious home looks
  like `leads.rating` and is the wrong one: that field is read-only because the
  scorer owns it, and when it was editable an edit was accepted, audited, and
  overwritten moments later — the rep saw Hot and the database kept Warm.
  Migration `166` adds `ipy_call.intent`, checked to the three words.
* **The WhatsApp follow-up is offered only when it could actually go**: a
  provider connected, an approved template, and its blanks filling for *this*
  person through the existing `/templates/:id/preview`, which resolves as the
  person asking. A template with a hole in it shows the reason with the switch
  dead. A refused send never loses the call that was just written.
* **Save & dial next** reads `GET /records/:module/:id/neighbours` — the same
  order the list is in — and then *navigates* to that record with `?dial=1`
  rather than swapping the person underneath the console. The provider belongs
  to whichever record is open, which is what makes the queue behave identically
  from the split view, the table and a record's own page. The flag is stripped
  on arrival, so a refresh cannot re-ring somebody already called.
* **The draft is this browser's**, every five seconds, cleared on save. A server
  write per keystroke against a call that does not exist yet is a row per
  keystroke.

### Ending the call from the computer, and the three rows

**21 September 2026, the owner:** *"I need to end call from popup … only call
icon button make call from android default dialler, if agent click on number
then the call should be transfer to action for mac/window dialler, live call
bar also be there."* Then, against the first build: *"the form too big, please
make it small as actual screenshot, and also the header first row, second row,
third row should be same as per screenshot."*

**The expensive assumption was mine, and reading Android's own reference killed
it.** "Hang up from the desk" was written down here as needing the
**default-dialler role** — `InCallService`, `ROLE_DIALER`, an in-call screen of
our own, and every call on the rep's phone going through iPropy. It does not.
`TelecomManager.endCall()` (API 28) requires **`ANSWER_PHONE_CALLS` and nothing
else**: one permission dialog, and the rep keeps the phone app they already
use. Deprecated in API 29 and still documented and still present — deprecated
is not removed — and it cannot end an emergency call, which is Android's
decision and the right one. **Check the live reference before pricing a feature
in someone else's UI.**

* **`ipy_device.can_end_call`** (migration `167`) is what the desk reads.
  Reported by the app every minute on the same heartbeat as `app_open_at`,
  never inferred from a version: a build can carry the code while the rep has
  taken the permission back in Android's settings, and the End button follows
  that within the minute.
* **A hang-up lives twenty seconds**, against a dial's ninety. A late dial
  rings somebody who was going to be rung anyway; a late hang-up cuts off the
  *next* conversation, and there is no undoing that.
* **One queue, one claim.** `/dial/pending` hands over any kind now, not only
  a dial, so the socket path and the five-second timer still cannot both be
  given the same command. A hang-up carries no number on purpose — the phone
  ends the call it is on, and a number there would invite ending the wrong one.
* **`POST /hangup` refuses rather than queueing** for a phone that cannot act,
  and the screen prints the reason. Pinned by
  `tests/integration/hangUpFromTheDesk.test.ts`, which also had to clear the
  account's other queued commands first — the same lesson as the reachability
  suite, met again.

**Two buttons, two diallers, and that split is the instruction.** The **Call
icon** rings the rep's Android phone, as it always has. **The number itself**
now hands off to whatever this computer uses for `tel:` — a softphone on a Mac
or a Windows machine — through `startCall(number, 'desk')`, which opens the
console and asks no handset at all. Somebody on a headset should not have to
pick up a phone; somebody in the field should not have their laptop try. In
the app there is one dialler and `startCall` knows it.

**The live call bar** (`LiveCallBar`): Close used to throw the call away —
notes, outcome, clock. It **minimises** now, into a bar with the person, the
timer, End where the phone allows it, and the way back in with everything still
typed. *Did not call* is the one way out that forgets. The pulse and the
three-bar equaliser are the only things on the page that move, which is the
point.

**The header is three rows, and which field lands on which is metadata.**
Row one is who, the live pill, the agent and the controls; row two is the
number, Copy, and **two facts a rep says out loud** — an empty one is skipped,
because "Email: —" on a call header is noise and two of them is the row; row
three is what the call *changes*, the stage and the chase date first
(`statusField`/`followUpField`, found by uitype, never by name), editable where
they stand. The record's own name is dropped from both (`module.labelFields`),
since it is the heading.

**Six outcome cards, not thirteen.** The picklist has thirteen and that is
three rows and a scroll after every call, so `splitOutcomes` shows the six a
rep uses all day — **in a fixed order, good first and gone last**, because a
row hit a hundred times a day should be muscle memory and an option renamed in
Settings must not move "Interested" under somebody's thumb. The rest are one
tap behind *"N more outcomes"*, which is also where an outcome an admin adds
appears — the e2e spec taps it, because Settings editing a list nobody can
reach is the bug that would replace the old one. **The chosen outcome is always
in the first six**, or picking one from "more" makes it vanish off the row
showing it as chosen.

`e2e/callOutcome.spec.ts` was rewritten around the cards and still proves the
same four promises (the list is the admin's, a save reaches the Calls tab, there
is no free-text path, an option added in Settings appears), plus the key-value
bar and the disabled End button. An a11y scan covers the console in both themes
and **creates its own lead with a number** — the first row in the list may have
none, and a spec that depends on what is already in the database reports the
machine it ran on.

**One fact worth keeping: `No Answer` is not one of this CRM's outcomes.**
`CALL_DISPOSITIONS` has thirteen and that is not among them, so the first cut of
the cards described an outcome the server refuses — caught by
`tests/integration/callConsoleSaves.test.ts`, which is the only layer that runs
the picklist check. It has a card anyway, for the admin who adds it.

---

## The call lives in the record's header now, not over it

**24 September 2026, the owner**, with a design of his own: *"we dont want that
full popup and things opening when click call button but instead now I want it
like this."*

Pressing Call used to cover the record with a dialog — so the one screen a rep
needs while talking was hidden behind the thing they pressed to start talking.
`components/CallDeck.tsx` sits in the header instead, two rows with his divider
between them: the clock, the equaliser and the call's own controls above; where
this record sits in the queue, what was said, and the way out below. The record
stays where it is, so status, follow-up date and notes are edited in place —
which is what the split view was built for.

* **One deck, two headers.** The split view and the record page both draw it
  from the same provider, so a rep who arrives either way sees the same thing
  and the two cannot drift.
* **Mute and keypad are drawn and dead on purpose**, as End already was.
  Android hands a running call to the handset's *default phone app* and to
  nobody else. They carry the reason in their tooltip and light up on their own
  the day `mayControlLiveCall` says otherwise.
* **The outcome is on the deck.** A call saved with no outcome is a row nobody
  can report on, so the admin's own picklist rides on the second row rather
  than being lost with the dialog.

**And Save & Next had never once worked.** It navigates to the next record with
`?dial=1`, and the effect that reads that flag needs the record's phone number —
but the record was fetched only while a call was already running. So arriving
with the flag, the number was unknown, the effect returned early, and the flag
sat in the address bar for ever: the next person opened and nobody was rung.
Fixed by fetching the record when a call is running **or** about to be placed.
Found by driving it in a real browser, which is the only place it shows.

**What went with the dialog, and is worth knowing before somebody asks for it
back:** the free-text call note, the Hot/Warm/Cold intent, the voice-dictated
note, and the WhatsApp follow-up switch. Notes have a home already — the Notes
panel is on screen beside the call. The other three are not offered anywhere
now; `ipy_call.intent` still exists and is simply never written.

**The deck floats, and that is the fix rather than a shortcut.** Sitting in the
header's own row it pushed the name, the assignment and every action circle
sideways the instant Call was pressed, and pulled them back when the call ended
— the bounce the owner reported the same day, with a screenshot. Positioned
absolutely in the header's top-right corner it changes no other element's
position at all, which is both what he drew and the only way a control that
appears mid-layout can avoid moving the page.

### The deck moves, and the header has a line down it

**24 September 2026, the owner:** *"I want this call panel to be movable …
by default it should be there in header only … you have put it in wrong place
it should be just a little below so things dont hide underneath it."*

* **Docked until somebody moves it.** No saved spot means the header positions
  it; a drag pins it to the window **at the pixel it already occupies**, so the
  first drag does not make it jump before it moves. Where it is left is
  remembered in this browser, like the split view's width and the list mode —
  a working habit, nobody else's business, and a round trip to ask where
  somebody likes their call panel is slow at exactly the wrong moment.
* **Dragged by a grip and nothing else.** Dragging from anywhere on it would
  mean a rep who meant to press End nudges the deck instead, mid-call.
  `setPointerCapture`, for the same reason the split view's divider uses it: a
  fast drag must not let go halfway across the screen.
* **It cannot be lost.** `keepOnScreen` holds enough of it in view to grab —
  on the drop *and* when the window is later made smaller. A deck off the edge
  with a live call inside it and no reachable End is the failure worth
  guarding, and `tests/dragDeck.test.ts` is only about that.
* **A way back.** A button appears on the deck once it has been moved, and a
  double-click on the grip does the same.
* **The dock sits below the action circles**, not over them. It was covering
  the star, the tag and the three dots — which is what "things hide underneath
  it" was.
* **The divider** runs between the record and what you do with it: to its left
  the name, the assignment and the fields; to its right the controls and, under
  them, the call. One hairline — a heavier rule in a header this tight reads as
  a border somebody forgot to remove.
