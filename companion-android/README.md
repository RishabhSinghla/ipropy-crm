# iPropy Call Sync — Android companion

Puts every call made or received on a salesperson's own phone into the CRM,
matched to the right lead. **No telephony account, no virtual number, no
per-minute cost.**

This is the alternative to cloud telephony, not a replacement for it. Cloud
telephony gives you one public number, IVR and routing; this gives you the calls
that actually happen, on the handsets people actually use, today.

---

## What it does

- Reads the system call log every 15 minutes and posts entries created after pairing to the CRM.
- Can import older call history when the user explicitly enables that option before the first sync.
- Matches each number to a lead on the last ten digits, so `98123 45678`,
  `+919812345678` and `09812345678` all find the same person.
- Updates the lead's last-contacted date, contact attempts and status.
- Optionally uploads call recordings your phone's own recorder made.
- Notifies you when an unknown number calls — a lead you do not have yet.

## What it cannot do

**It cannot record calls.** Android 10 closed that API and nothing reopens it.
What it can do is upload recordings *your phone's built-in recorder* already
makes. Most Indian-market phones (Xiaomi, Realme, Samsung, OnePlus, Vivo, Oppo)
have one — switch it on in the Phone app's settings, and this app finds the
files.

If your phone has no built-in recorder, the call log still syncs. Only the audio
is missing.

---

## Install

### 1. Get a pairing token

In the CRM: **Settings → Phones → Pair a phone**. Copy the token — it is shown
once and only its hash is stored.

### 2. Build the APK

```bash
cd companion-android && ./gradlew assembleRelease
```

The APK lands in `app/build/outputs/apk/release/`.

Needs Android Studio or the command-line SDK tools, JDK 17, and a `local.properties`
containing `sdk.dir=/path/to/Android/sdk`.

### 3. Sideload it

Send the APK to each phone, tap it, and allow installation from unknown sources
when prompted.

### 4. Pair

Open the app, enter your secure CRM address (`https://…`) and the token, tap
**Pair**, and grant call log access. Use a work phone or work SIM: Android's call
log covers the whole handset, not just one CRM app.

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

The token can be revoked from the CRM at any time (**Settings → Phones →
Revoke**), which stops the phone immediately without touching the handset.

---

## Battery

The sync is WorkManager periodic work with a 15-minute period — the OS floor.
It wakes, reads rows newer than the last one sent, posts them and sleeps. On a
normal sales day that is a few hundred kilobytes and a negligible share of the
battery.

On Xiaomi, Oppo and Vivo, also allow the app to **autostart** and set its battery
policy to **No restrictions**, or the OEM's task killer will stop the sync
silently. This is the single most common reason a phone "stops syncing".
