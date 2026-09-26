package com.ipropy.crm

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.telecom.TelecomManager
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.ipropy.crm.callsync.Api
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
        Permission(alias = CallSyncPlugin.PLACE_CALL, strings = [Manifest.permission.CALL_PHONE]),
        Permission(alias = CallSyncPlugin.END_CALL, strings = [Manifest.permission.ANSWER_PHONE_CALLS]),
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
        put("callPhoneGranted", getPermissionState(PLACE_CALL)?.toString() == "granted")
        put("canEndCall", canEndCall())
        put("canControlCall", isCallApp())
        put("locationGranted", getPermissionState(LOCATION)?.toString() == "granted")
        put("backgroundLocationGranted", hasBackgroundLocation())
        put("lastSyncAt", prefs.lastSyncAt)
        put("lastSyncSummary", prefs.lastSyncSummary)
        put("locationEnabled", prefs.locationEnabled)
        put("recordingFolderChosen", !prefs.recordingTreeUri.isNullOrBlank())
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

    /**
     * Point the app at the folder this phone's own call recorder saves to.
     *
     * **Without this no recording has ever reached the CRM.** Android 10 shut
     * third-party call recording, so iPropy reads the files the phone maker's
     * recorder writes — and modern Android hides that folder from every app
     * until the person picks it in Android's own folder chooser. The engine
     * that matches and uploads the files was here all along; nothing ever let
     * anybody choose the folder. The grant is kept across reboots and covers
     * that folder and nothing else.
     */
    @PluginMethod
    fun chooseRecordingFolder(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        startActivityForResult(call, intent, "afterRecordingFolder")
    }

    @ActivityCallback
    private fun afterRecordingFolder(call: PluginCall, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != android.app.Activity.RESULT_OK || uri == null) {
            call.resolve(currentStatus())
            return
        }
        try {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: SecurityException) {
            call.resolve(currentStatus())
            return
        }
        prefs.recordingTreeUri = uri.toString()
        prefs.uploadRecordings = true
        // Look straight away rather than at the next fifteen-minute sync.
        WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<SyncWorker>().build())
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

    /** Set up desktop calling in one action, using Android's normal consent prompts. */
    @PluginMethod
    fun requestCallPermissions(call: PluginCall) {
        requestMissingCallPermission(call)
    }

    private fun requestMissingCallPermission(call: PluginCall) {
        if (getPermissionState(CALL_LOG)?.toString() != "granted") {
            requestPermissionForAlias(CALL_LOG, call, "afterCallPermissions")
            return
        }
        if (getPermissionState(PLACE_CALL)?.toString() != "granted") {
            requestPermissionForAlias(PLACE_CALL, call, "afterCallPermissions")
            return
        }
        call.resolve(currentStatus())
    }

    @PermissionCallback
    private fun afterCallPermissions(call: PluginCall) {
        requestMissingCallPermission(call)
    }

    /**
     * Ring a number, because the CRM asked this handset to.
     *
     * `ACTION_CALL` and not `ACTION_DIAL`: dial only fills the number in and
     * waits for a thumb, which defeats the point — the rep pressed Call on a
     * laptop and is not holding the phone. With CALL_PHONE granted there is no
     * app chooser either, which is the dialog this whole path exists to remove.
     *
     * The permission is asked for here rather than at pairing, so a rep who
     * only ever wants their calls logged is never asked for the right to make
     * one. Refusing it costs this feature and nothing else: the CRM hears
     * `placed: false` and says so instead of claiming a call that never rang.
     *
     * Whatever happens is posted back with the *device* token, which only this
     * side holds — the webview's session cannot speak for a handset.
     */
    @PluginMethod
    fun placeCall(call: PluginCall) {
        val number = call.getString("number").orEmpty().trim()
        if (number.isEmpty()) { call.reject("No number to call"); return }
        if (getPermissionState(PLACE_CALL)?.toString() != "granted") {
            requestPermissionForAlias(PLACE_CALL, call, "afterPlaceCall")
            return
        }
        dialNow(call, number)
    }

    @PermissionCallback
    private fun afterPlaceCall(call: PluginCall) {
        val number = call.getString("number").orEmpty().trim()
        if (getPermissionState(PLACE_CALL)?.toString() != "granted") {
            report(call.getString("commandId"), false, "permission-refused")
            call.resolve(JSObject().put("placed", false).put("reason", "permission-refused"))
            return
        }
        dialNow(call, number)
    }

    private fun dialNow(call: PluginCall, number: String) {
        val commandId = call.getString("commandId")
        try {
            val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            report(commandId, true, null)
            call.resolve(JSObject().put("placed", true))
        } catch (e: Exception) {
            // A handset with no SIM, a work profile that forbids calls, or a
            // number the dialler will not take. Reported rather than thrown:
            // the CRM has to be able to say "it did not ring".
            report(commandId, false, e.message ?: "failed")
            call.resolve(JSObject().put("placed", false).put("reason", e.message ?: "failed"))
        }
    }

    /**
     * End the call this handset is on, because the CRM asked it to.
     *
     * `TelecomManager.endCall()` with `ANSWER_PHONE_CALLS`, and **not** the
     * default-dialler role. Read off Android's own reference on 21 September
     * 2026 rather than assumed: the role would mean replacing the phone app
     * the rep already uses, in-call screen and all, to reach the same button.
     * This costs one permission dialog and changes nothing else about their
     * phone.
     *
     * Three honest refusals, each reported rather than thrown:
     *
     *  * **Below Android 9** the method does not exist at all.
     *  * **Permission refused**, which the rep may do and may later undo.
     *  * **`false` from Telecom** — an emergency call, which Android will not
     *    let any app end, or an OEM that refuses anyway. The CRM says the call
     *    is still up instead of claiming it cut one off.
     *
     * Deprecated in API 29 and still present. If a future Android removes it,
     * this answers false and the desk's End button goes dead on its own,
     * which is the failure mode to want.
     */
    @PluginMethod
    fun endCall(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            finishEnd(call, false, "android-too-old")
            return
        }
        if (getPermissionState(END_CALL)?.toString() != "granted") {
            requestPermissionForAlias(END_CALL, call, "afterEndCall")
            return
        }
        endNow(call)
    }

    @PermissionCallback
    private fun afterEndCall(call: PluginCall) {
        if (getPermissionState(END_CALL)?.toString() != "granted") {
            finishEnd(call, false, "permission-refused")
            return
        }
        endNow(call)
    }

    private fun endNow(call: PluginCall) {
        try {
            val telecom = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            @Suppress("DEPRECATION")
            val ended = telecom.endCall()
            finishEnd(call, ended, if (ended) null else "no-call-to-end")
        } catch (e: SecurityException) {
            finishEnd(call, false, "permission-refused")
        } catch (e: Exception) {
            finishEnd(call, false, e.message ?: "failed")
        }
    }

    private fun finishEnd(call: PluginCall, ended: Boolean, reason: String?) {
        report(call.getString("commandId"), ended, reason)
        val result = JSObject().put("ended", ended)
        if (reason != null) result.put("reason", reason)
        call.resolve(result)
    }

    /**
     * Whether this handset can end a call today.
     *
     * Asked every minute by the app rather than remembered, because the rep
     * can take the permission back from Android's settings at any moment and
     * the CRM would otherwise keep offering a button that does nothing.
     */
    @PluginMethod
    fun callControl(call: PluginCall) {
        call.resolve(JSObject().put("canEndCall", canEndCall()).put("canControlCall", isCallApp()))
    }

    /**
     * Make iPropy this phone's calling app — Android's own "set as default"
     * dialog, which the rep can answer either way and reverse from Android's
     * settings at any time.
     *
     * The one thing that lets the CRM switch speaker, mute and hold on a
     * running call and know when the other side picks up: Android gives
     * those to the calling app and nobody else.
     */
    @PluginMethod
    fun requestCallApp(call: PluginCall) {
        if (isCallApp()) { call.resolve(JSObject().put("canControlCall", true)); return }
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roles = context.getSystemService(android.app.role.RoleManager::class.java)
            roles.createRequestRoleIntent(android.app.role.RoleManager.ROLE_DIALER)
        } else {
            Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER)
                .putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, context.packageName)
        }
        startActivityForResult(call, intent, "afterCallApp")
    }

    @ActivityCallback
    private fun afterCallApp(call: PluginCall, result: ActivityResult) {
        call.resolve(JSObject().put("canControlCall", isCallApp()))
    }

    /** Android's settings page where the rep can hand the calling app back. */
    @PluginMethod
    fun openCallAppSettings(call: PluginCall) {
        val intent = Intent(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS
            else Settings.ACTION_SETTINGS,
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    /**
     * Speaker, mute, hold or end on the call this phone is on — an
     * instruction from the desk that reached the app's web view first. The
     * same [LiveCall.perform] the phone's own buttons use.
     */
    @PluginMethod
    fun callAction(call: PluginCall) {
        val action = call.getString("action").orEmpty()
        val on = call.getBoolean("on", true) ?: true
        val error = com.ipropy.crm.calls.LiveCall.perform(action, on)
        report(call.getString("commandId"), error == null, error)
        val result = JSObject().put("done", error == null)
        if (error != null) result.put("reason", error)
        call.resolve(result)
    }

    private fun isCallApp(): Boolean {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        return telecom.defaultDialerPackage == context.packageName
    }

    /** Ask for the permission, showing Android's own dialog. */
    @PluginMethod
    fun requestDialerRole(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            call.resolve(JSObject().put("canEndCall", false))
            return
        }
        if (canEndCall()) { call.resolve(JSObject().put("canEndCall", true)); return }
        requestPermissionForAlias(END_CALL, call, "afterDialerRole")
    }

    @PermissionCallback
    private fun afterDialerRole(call: PluginCall) {
        call.resolve(JSObject().put("canEndCall", canEndCall()))
    }

    private fun canEndCall(): Boolean = isCallApp() || (
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            getPermissionState(END_CALL)?.toString() == "granted"
        )

    /** Close the command out, if it came from one. Best effort, off the main thread. */
    private fun report(commandId: String?, ok: Boolean, error: String?) {
        val id = commandId ?: return
        val base = prefs.baseUrl ?: return
        val token = try { prefs.token } catch (e: Exception) { null } ?: return
        Thread { Api.reportCommand(base, token, id, ok, error) }.start()
    }

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
        const val PLACE_CALL = "placeCall"
        const val END_CALL = "endCall"
    }
}
