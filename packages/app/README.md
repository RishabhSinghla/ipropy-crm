# iPropy for Android and iPhone

The CRM as an installed app. Same React bundle `packages/web` builds, wrapped
in a real Android and iOS project, served from inside the app rather than over
the network, with the phone's own camera, location, notifications and call log
wired in.

One app, not two: the standalone call-logging companion (`companion-android/`)
is folded in here, so a rep installs one thing.

---

## Why it is built this way

The CRM is metadata-driven. Modules, fields, layouts, dropdowns and permissions
are rows in a database, and an admin reshapes the product at runtime with no
deploy. Every screen in the web app is generated from that at render time.

A hand-written native UI — Kotlin, Swift, React Native — would have to
reimplement the field renderer, the layout engine, conditional visibility, the
permission stripping and the picklist machinery, in two languages, and would
then be **frozen**: renaming a field in the admin panel would need a Play Store
release and an App Store review to reach a phone. That is the opposite of what
this product is.

So the app runs the same engine and gives it phone-shaped screens
(`packages/web/src/mobile/`). Rename a field and the app follows immediately.

**This is not the website in a box.** The app has its own screens — a list is
an avatar, a name and a number; a record is a contact card; editing is a bottom
sheet with one field in it. The desktop furniture (row checkboxes, saved-view
tab strips, filter builders, column choosers, pagers) is not drawn at all. A
phone *browser* still gets the responsive web layout, unchanged — this is a
different product surface, deliberately not a breakpoint.

---

## Layout

```
packages/app/
  android/          the Android project (committed)
  ios/              the iOS project (committed)
  assets/           icon and splash sources — see "Changing the icon" below
  scripts/
    make-release-key.sh   run once, ever
    publish-apk.sh        build a signed release and put it where the CRM serves it
```

The Capacitor config lives at `packages/web/capacitor.config.ts`, not here, so
there is exactly **one** list of plugins — the dependencies of `@ipropy/web`.
`cap sync` reads that list to copy each plugin's native code in, and the bundler
resolves the same list for the `await import()` calls in `src/lib/native*.ts`.
Two lists would drift, and the failure would be a plugin that type-checks,
builds, ships, and then does nothing on the phone.

The native projects are kept out of `packages/web` because everything there is
copied into the Docker image Render builds, and a Gradle project has no business
in a web server.

---

## Building

Needs **JDK 21** and the Android command-line tools.

```bash
brew install openjdk@21
# Android SDK: /opt/homebrew/share/android-commandlinetools
```

JDK 21 specifically, not 17 and not whatever `java` resolves to. Capacitor 8's
plugins declare a Java 21 toolchain and Gradle will not substitute another — it
fails with *Cannot find a Java installation matching languageVersion=21*, which
reads like a broken Gradle rather than a missing JDK.

```bash
# a debug build on a connected phone or emulator
cd packages/web && npm run build && npx cap sync android
cd ../app/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# a signed release, published where the CRM hands it out
bash packages/app/scripts/publish-apk.sh
git add packages/server/public/companion && git commit && git push
```

`publish-apk.sh` reads the version back out of the built APK rather than from a
number typed twice, checks the APK is actually signed, and writes the metadata
the download page reads. The APK travels in git because the container has no
Android SDK and Render has no artefact store.

### Changing the icon or the splash

Edit the sources in `assets/` and fan them out to every density both platforms
want:

```bash
cd packages/web
npx @capacitor/assets@3 generate --assetPath ../app/assets \
  --android --androidProject ../app/android \
  --ios --iosProject ../app/ios/App
```

`npx`, not a saved dependency, and deliberately so. That generator bundles
Capacitor CLI 5 alongside the 8 this project uses, and with it an old `tar` and
an old `sharp` — fourteen advisories, all of them for a tool that runs about
once a year and whose output is committed. Installing it permanently means
carrying those in the lockfile for ever; `npx` fetches it for the minute it is
needed.

The generated files are committed, so nobody needs this to build the app.

### Testing against a laptop rather than production

A release build talks to `https://crm.ipropy.com`. To point a debug build
somewhere else:

```bash
cd packages/web && VITE_API_BASE=http://10.0.2.2:4000 npm run build && npx cap sync android
```

`10.0.2.2` is the emulator's alias for the machine running it. Two things have
to be true for plain HTTP to work and **both fail identically**, as a request
that never happens rather than an error:

* `src/debug/res/xml/network_security_config.xml` permits cleartext to that host.
* `MainActivity` sets `MIXED_CONTENT_ALWAYS_ALLOW` — the app's own page is
  `https://localhost`, so the webview blocks plain-HTTP subresources as mixed
  content. On screen this reads as *"Could not sign in"*, which sends you
  looking at passwords and CORS rather than at the scheme.

Both are `src/debug` only and absent from a release build.

---

## iPhone

The project is complete and has never been built, because building it needs
Xcode, which is not installed on the machine this was written on.

To ship it you need:

* **Xcode** — free, about 15 GB, from the App Store.
* **CocoaPods** — `brew install cocoapods`.
* An **Apple Developer account**, about ₹8,200/year. Without one the app can
  only be installed over a cable from the Mac that built it, and it stops
  working after seven days.

```bash
cd packages/web && npm run build && npx cap sync ios
npx cap open ios          # then Product → Archive
```

`Info.plist` already carries every permission string iOS demands. A missing one
is not a declined dialog — it is an immediate crash with a console line nobody
on a phone can read.

---

## What is native, and what is not

| | |
|---|---|
| Camera, photo library | the OS picker, through the webview's file input |
| Location | `@capacitor/geolocation`, which owns the permission conversation |
| Notifications | Firebase on Android, APNs on iPhone. See below |
| Call log | Android only. A background worker every 15 minutes |
| Files out of the CRM | written to cache, handed to the share sheet |
| Session | kept in native storage, not a cookie |
| Deep links | `https://crm.ipropy.com/...` opens the app |

### Notifications need a Firebase project

Drop `google-services.json` into `packages/app/android/app/` and paste the
service-account JSON into **Admin → Integrations → App notifications**. Both are
free. Until then the in-app bell and Web Push still work and the app simply
receives nothing when it is closed — `sendFcm` returns having done nothing.

Two traps, both encoded in the code and both silent:

* An Android notification naming a channel that does not exist is **dropped** —
  not shown quietly: dropped, with `sent` from Firebase and nothing on the
  handset. The app creates `ipropy-alerts` on every launch.
* Registration is not the permission dialog. Resolving after the dialog reports
  success and delivers nothing, ever, so the app waits for the token — with a
  timeout, because a handset with no Play services never calls back.

### The call log is Android only

iOS exposes no call-log API to any app at any permission level. This is not a
gap to fill later; there is nothing to fill it with, and the iPhone build says
nothing about it rather than promising something Apple does not allow.

`READ_CALL_LOG` is restricted by Google Play to apps whose core function is call
management. Sideloading to a known team avoids that review entirely; a Play
Store listing would need a Permissions Declaration.

**A phone paired with the old companion app cannot be read from here.** Android
gives every app its own private storage and `com.ipropy.callsync` is a different
app. Those handsets pair again, which now costs one tap — the rep is already
signed in, so the app mints its own device token.

---

## Two things that will break the app and are easy to do by accident

**Removing the localhost origins from `allowedOrigins()`** in
`packages/server/src/config.ts`. They read exactly like a development leftover.
A Capacitor app's requests carry `https://localhost` (Android) or
`capacitor://localhost` (iOS), so both apps stop at the login screen with a CORS
error — on production only, with every test green and the website unaffected.
`tests/allowedOrigins.test.ts` fails if either goes.

**Losing `ipropy-release.keystore`.** Android decides whether one APK may
replace another by comparing signatures. There is no route back: every handset
with the app installed has to uninstall it — losing its pairing and its session
— before it can take an update. Back the keystore and `keystore.properties` up
somewhere that is not the laptop that made them.
