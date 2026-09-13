# iPropy Call Sync — Android companion

Puts every call made or received on a salesperson's own phone into the CRM,
matched to the right lead. **No telephony account, no virtual number, no
per-minute cost.**

This is the alternative to cloud telephony, and it is the route this product
took: the Twilio and Exotel integrations were removed in September 2026 having
never been switched on. Cloud telephony would give you one public number, IVR
and routing; this gives you the calls that actually happen, on the handsets
people actually use, today.

---

## What it does

- Reads the system call log every 15 minutes and posts entries created after pairing to the CRM.
- Can import older call history when the user explicitly enables that option before the first sync.
- Matches each number to a lead on the last ten digits, so `98123 45678`,
  `+919812345678` and `09812345678` all find the same person.
- Updates the lead's last-contacted date, contact attempts and status.
- Optionally uploads call recordings your phone's own recorder made.
- Notifies you when an unknown number calls — a lead you do not have yet.
- Sends the phone's position on the same 15-minute wake, **if an admin has
  switched that on** in the CRM. Off out of the box. See [Location](#location).

## What it cannot do

**It cannot record calls.** Android 10 closed that API and nothing reopens it.
What it can do is upload recordings *your phone's built-in recorder* already
makes. Most Indian-market phones (Xiaomi, Realme, Samsung, OnePlus, Vivo, Oppo)
have one — switch it on in the Phone app's settings, and this app finds the
files.

If your phone has no built-in recorder, the call log still syncs. Only the audio
is missing.

**It cannot follow somebody minute by minute.** A position arrives every 15
minutes at best, because that is the shortest period Android will wake a
background app for. Between two readings a rep can drive ten kilometres and
come back, and the map will never know.

**It cannot tell two neighbouring flats apart.** A phone fix is accurate to
roughly 10 to 20 metres outdoors and worse indoors. That is enough to say
somebody reached a project, and nowhere near enough to say which floor or which
of two adjacent builder floors they walked into.

---

## Installing it on a phone

The CRM hands the app out itself, so there is nothing to email around.

1. On the handset, open the CRM and go to **Settings → Phones**. Tap
   **Download the app**.
2. Android warns that the file did not come from the Play Store. Tap the
   Settings button on that warning, allow your browser to install apps, then
   tap the downloaded file again.
3. Back in **Settings → Phones**, tap **Pair a phone** and copy the token. It
   is shown once; only its hash is kept.
4. Open the app, enter the CRM address (`https://…`) and the token, and tap
   **Pair**.
5. Grant call log, notifications and location when asked.
6. Location needs a second step. Android will not offer "Allow all the time" in
   a pop-up, so the app opens the phone's own settings page for you. Change
   location from "While using the app" to "Allow all the time" there.
7. On Xiaomi, Oppo, Vivo and Realme, switch **Autostart** on and set the
   battery policy to **No restrictions**. See [Battery](#battery).

Use a work phone or work SIM. Android's call log covers the whole handset, not
just one app.

---

## Building it

Only needed when the Android code changes. Everything below is a one-off except
the last command.

**Once, on the Mac that builds it:**

```bash
brew install openjdk@17
brew install --cask android-commandlinetools
yes | sdkmanager --licenses
sdkmanager --install "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

Then a `local.properties` in this folder, pointing at whatever
`brew --prefix` gave you:

```
sdk.dir=/opt/homebrew/share/android-commandlinetools
```

**Once, ever:** make the signing key.

```bash
./scripts/make-release-key.sh
```

This writes `~/.ipropy/companion/ipropy-release.jks` and a
`keystore.properties` beside this README. Neither is committed. **Back up
`~/.ipropy/companion` somewhere that is not this laptop.** Android decides
whether one APK may replace another by comparing signatures, so an APK signed
with a different key cannot install over the copy already on a rep's phone. The
only way out of that is every rep uninstalling first, which throws away their
pairing and their sync position.

**Every time the app changes:**

```bash
./scripts/publish-apk.sh
```

That builds, signs, copies the APK to `packages/server/public/companion/`, and
writes a small JSON file next to it with the version, size and checksum read
back out of the APK itself. Commit both files and push. Render carries them
into the image, and **Settings → Phones** starts offering the new version.

Bump `versionCode` and `versionName` in `app/build.gradle.kts` before you
publish, together. `versionCode` is the number Android compares when deciding
whether an APK is an upgrade; a build that does not raise it will not install
over the one already on the phone.

### If you move the file somewhere else

`Admin → Settings → Where the Android app is downloaded from` takes a web
address. Leave it empty and the CRM serves the file itself, which is what you
want. Fill it in and every download follows it instead, with no rebuild of
anything.

To upload recordings, enable the option and choose the exact folder used by the
phone's built-in recorder in Android's system folder picker. The app receives a
persistent read grant to that folder only; it does not request broad storage
access.

---

## Why sideload instead of the Play Store

`READ_CALL_LOG` is a restricted permission. Google Play only allows it for apps
whose core function is call management. A CRM companion may be eligible, but
Google decides this during review and the listing needs a Permissions
Declaration.

Sideloading to your own team avoids that store review. If you later publish it,
review the then-current Google Play call-log policy and submit the declaration
and demonstration it requires.

---

## Privacy and consent

This app reads call metadata — numbers, times, durations — and uploads it to
**your own** CRM. Nothing goes anywhere else; there is no analytics SDK and no
third-party dependency that phones home.

Two things worth being deliberate about:

- **Tell your team.** Their personal calls on that handset may sync too. Use a
  work-only handset or work SIM and obtain informed employee consent.
- **Recordings.** Recording and retention rules depend on the parties,
  jurisdiction and purpose. Obtain appropriate consent, publish a retention
  policy, restrict playback access, and get legal advice for your deployment.
- **Location, if you switch it on.** Where an employee is during the day is
  personal data under India's DPDP Act 2023. The Act expects the person to be
  told what is collected and why, and to be able to ask what is held about them.
  Tell the team before the switch goes on rather than after somebody notices a
  pin with their name on it, keep the hours to working hours, and keep the
  retention short. The feature ships off for this reason and not by oversight.

The token can be revoked from the CRM at any time (**Settings → Phones →
Revoke**), which stops the phone immediately without touching the handset.

---

## Location

Off unless an admin turns it on, and the phone asks the CRM every wake rather
than deciding for itself. That means the whole thing — on or off, how often,
which hours of the day — is changed in **Admin → Settings → Team location** and
takes effect on every handset at its next wake. Nobody re-installs anything.

The admin map is **Admin → Team map**. Each pin is one rep's last known
position, with how long ago it was taken, the phone's battery, and the property
they are standing at if there is one within the radius you set.

### Switching it on

1. **Admin → Settings → Team location → Record team positions.** Nothing is
   stored until this is on, and turning it off again stops storage the same
   minute and empties what each phone had queued.
2. Set the hours. The default is 9am to 8pm, so a phone in somebody's kitchen at
   11pm reports nothing.
3. Set how long to keep the history. The default is 30 days, after which points
   delete themselves every hour without anybody remembering to do it.

### The permission Android will not let the app ask for

This is the part that surprises people, so it is worth reading before handing
out handsets.

Android lets an app show a dialog for *"While using the app"*. It does **not**
let an app show a dialog for *"Allow all the time"* — since Android 10 that
choice exists only in the phone's own Settings, and an app that asks for it in a
dialog is refused silently.

So on each handset, after pairing:

1. Tap **Allow location** in the app and choose **While using the app**.
2. The app then offers to open Settings. Tap through, find **Permissions →
   Location**, and choose **Allow all the time**.

Skip step 2 and positions arrive only while somebody has the app open on screen,
which in practice means almost never.

### Xiaomi, Oppo, Vivo, Realme

The same **Autostart** and **No restrictions** battery settings that keep calls
syncing are what keep positions arriving. A handset that has "stopped showing on
the map" has almost always had its autostart switched off by a battery-saver
sweep. Check that before assuming the app is broken.

### What is actually stored

One row per reading: who, when, where, how accurate, battery, and the property
they were near. There is no audio, no screen contents, and nothing about which
apps were used. The phone keeps unsent readings for as long as it is offline and
throws away the oldest once it is holding 200 of them.

---

## Battery

The sync is WorkManager periodic work with a 15-minute period — the OS floor.
It wakes, reads rows newer than the last one sent, posts them and sleeps. On a
normal sales day that is a few hundred kilobytes and a negligible share of the
battery.

On Xiaomi, Oppo and Vivo, also allow the app to **autostart** and set its battery
policy to **No restrictions**, or the OEM's task killer will stop the sync
silently. This is the single most common reason a phone "stops syncing".
