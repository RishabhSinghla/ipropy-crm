# iPROPY Dialer

`iPROPY Dialer` is a new, standalone Android app. It is **not** an update to
the existing iPROPY CRM Android app or the existing Call Sync companion.

## What this first build does

- Sign in securely to the existing iPROPY CRM.
- Load the signed-in user's permitted Lead or Inventory queue from CRM.
- Offer a manual-number dialling path and a power-dial queue.
- Launch the handset's normal phone app for the actual call.
- Save the call outcome, note, optional next follow-up and chosen CRM status
  back to the original Lead/Inventory record.
- Use CRM's live Call Disposition and status picklists instead of app-owned
  copies, so an admin's choices remain the source of truth.

Calls are logged through the existing CRM telephony API. This preserves the
existing web-to-Android click-to-call path and the separate Call Sync app.

## Important operating boundary

Power dial means the next CRM record is presented after the salesperson has
saved the result of the previous call. The app does not place unattended or
background calls. Automated, carrier-originated calling requires a separately
contracted and configured telephony provider, consent controls, and the
applicable TRAI/legal review; none is silently introduced here.

## Build a debug APK

This project is deliberately independent from `companion-android`:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
  ./gradlew :app:assembleDebug
```

The output is `app/build/outputs/apk/debug/app-debug.apk`. A distribution
release must use a new signing key for package `com.ipropy.dialer`; it must not
reuse or replace the existing companion application identity.

## Verification completed

- Debug APK compiled successfully with Android API 34.
- The existing CRM Android packages were not modified.
- This app is not yet served from CRM Settings or deployed to users; that
  requires a signed beta release and a deliberate admin distribution entry.
