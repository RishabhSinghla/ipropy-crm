package com.ipropy.crm

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.ipropy.crm.callsync.CallLogReader
import com.ipropy.crm.callsync.Prefs
import com.ipropy.crm.callsync.SyncWorker

/**
 * The call sync, as something the CRM's own Settings screen can drive.
 *
 * The engine underneath — `callsync/` — is the standalone companion app's,
 * carried across unchanged because it is proved on real handsets and the parts
 * that took longest to get right (WorkManager surviving Xiaomi's battery
 * manager, matching a recording to a call, the ten-digit number match) are
 * exactly the parts worth not rewriting.
 *
 * What changes is how a phone gets paired. The companion app showed a box to
 * paste a token into, which meant a rep with a fresh handset had to be sent one
 * out of band. Here the rep is already signed into the CRM in this very app, so
 * the web side mints its own device token and hands it over — there is nothing
 * to type and nothing to send.
 *
 * Consequence worth being plain about: a handset paired with the old companion
 * app cannot be read from here. Android gives each app its own private storage
 * and `com.ipropy.callsync` is a different app to this one. Those phones pair
 * again, which now costs a tap rather than a token.
 */
@CapacitorPlugin(
    name = "CallSync",
    permissions = [
        Permission(alias = CallSyncPlugin.CALL_LOG, strings = [Manifest.permission.READ_CALL_LOG]),
        Permission(alias = CallSyncPlugin.LOCATION, strings = [
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ]),
    ],
)
class CallSyncPlugin : Plugin() {

    private val prefs: Prefs by lazy { Prefs(context) }

    /**
     * Everything the Settings screen needs to describe the state of this phone
     * in a sentence, rather than a switch that is either on or lying.
     */
    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(currentStatus())
    }

    private fun currentStatus(): JSObject = JSObject().apply {
        put("available", true)
        put("paired", prefs.token != null)
        put("callLogGranted", getPermissionState(CALL_LOG)?.toString() == "granted")
        put("locationGranted", getPermissionState(LOCATION)?.toString() == "granted")
        put("backgroundLocationGranted", hasBackgroundLocation())
        put("lastSyncAt", prefs.lastSyncAt)
        put("lastSyncSummary", prefs.lastSyncSummary)
        put("locationEnabled", prefs.locationEnabled)
        put("uploadRecordings", prefs.uploadRecordings)
        put("version", BuildConfig.VERSION_NAME)
    }

    /**
     * Take a device token minted by the signed-in session and start syncing.
     *
     * `importHistory` decides what "since" means, and it can only be decided
     * once. Off — the default — sets the watermark to the newest call already
     * on the phone, so the CRM fills with calls made from now on. On, it starts
     * from nothing and uploads whatever the handset still holds, which on a
     * two-year-old phone is thousands of calls including every personal one.
     */
    @PluginMethod
    fun pair(call: PluginCall) {
        val baseUrl = call.getString("baseUrl")
        val token = call.getString("token")
        if (baseUrl.isNullOrBlank() || token.isNullOrBlank()) {
            call.reject("A server address and a device token are both required")
            return
        }

        prefs.baseUrl = baseUrl.trimEnd('/')
        prefs.token = token
        prefs.importExistingHistory = call.getBoolean("importHistory", false) == true

        /*
          The watermark is set here and never again. Without it the first run
          reads the whole call log: a rep's personal calls going back years,
          uploaded to their employer's CRM, which is not a thing to do by
          accident.
        */
        if (!prefs.watermarkInitialised) {
            if (prefs.importExistingHistory) {
                prefs.watermarkInitialised = true
            } else {
                /*
                  Refuse to pair rather than guess. The watermark is the line
                  between "calls from now on" and "every call on this handset,
                  personal ones included", and a failed read cannot be told from
                  an empty call log unless this asks. Pairing anyway with a
                  watermark of zero is how somebody who explicitly declined
                  history gets all of it.
                */
                val newest = CallLogReader.currentHighestId(context)
                if (newest == null) {
                    call.reject("Could not read this phone's call log, so call logging was not switched on. Check that the permission is allowed and try again.")
                    return
                }
                prefs.lastCallId = newest
                prefs.watermarkInitialised = true
            }
        }

        SyncWorker.schedule(context)
        call.resolve(currentStatus())
    }

    /** Stop syncing and forget the token. The CRM revokes its side separately. */
    @PluginMethod
    fun unpair(call: PluginCall) {
        SyncWorker.cancel(context)
        prefs.clear()
        call.resolve(currentStatus())
    }

    /**
     * Run the sync now rather than waiting up to fifteen minutes.
     *
     * Enqueued as one-time work rather than run inline, so it goes through
     * exactly the same path as the scheduled run. A "Sync now" that takes a
     * different route is a button that proves nothing about whether the
     * scheduled one works — and the scheduled one is the one that matters.
     */
    @PluginMethod
    fun syncNow(call: PluginCall) {
        if (prefs.token == null) { call.reject("This phone is not paired yet"); return }
        WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<SyncWorker>().build())
        call.resolve(JSObject().put("started", true))
    }

    @PluginMethod
    fun setLocationEnabled(call: PluginCall) {
        prefs.locationEnabled = call.getBoolean("enabled", false) == true
        call.resolve(currentStatus())
    }

    @PluginMethod
    fun setUploadRecordings(call: PluginCall) {
        prefs.uploadRecordings = call.getBoolean("enabled", false) == true
        call.resolve(currentStatus())
    }

    /** Ask for the call log. Refusing costs the call sync and nothing else. */
    @PluginMethod
    fun requestCallLog(call: PluginCall) {
        if (getPermissionState(CALL_LOG)?.toString() == "granted") { call.resolve(currentStatus()); return }
        requestPermissionForAlias(CALL_LOG, call, "afterCallLog")
    }

    @PermissionCallback
    private fun afterCallLog(call: PluginCall) = call.resolve(currentStatus())

    @PluginMethod
    fun requestLocation(call: PluginCall) {
        if (getPermissionState(LOCATION)?.toString() == "granted") { call.resolve(currentStatus()); return }
        requestPermissionForAlias(LOCATION, call, "afterLocation")
    }

    @PermissionCallback
    private fun afterLocation(call: PluginCall) = call.resolve(currentStatus())

    /**
     * "Allow all the time" cannot be asked for in a dialog.
     *
     * From Android 10 the only way to grant background location is for the
     * person to open this app's settings page and choose it themselves. An app
     * that bundles it into the ordinary request is refused silently — the
     * dialog appears, they tap Allow, and the permission they tapped Allow for
     * is not the one that was needed.
     */
    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    private fun hasBackgroundLocation(): Boolean {
        // Below Android 10 there is no separate background permission: ordinary
        // location covers it, so reporting false would be a warning about a
        // problem the handset does not have.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return getPermissionState(LOCATION)?.toString() == "granted"
        }
        return context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    companion object {
        const val CALL_LOG = "callLog"
        const val LOCATION = "location"
    }
}
