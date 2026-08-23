package com.ipropy.callsync

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * One position, when the CRM asks for one.
 *
 * **Android's own LocationManager, not Play Services.** Fused location is more
 * accurate and would add Google Play Services to an app that currently has no
 * dependency heavier than WorkManager — and this app is sideloaded onto a
 * team's own handsets by a person holding each phone, so every dependency is
 * another way a build fails on a machine nobody has set up for it. The platform
 * API is accurate to ten or twenty metres outdoors, which is the same order as
 * the question being asked: did they reach the address.
 *
 * **Not a foreground service, deliberately.** A service would allow readings
 * more often than every fifteen minutes, and would cost a permanent
 * notification the rep cannot dismiss — and on the Xiaomi, Oppo, Vivo and
 * Realme handsets that make up most of this market it would still be killed.
 * The same conclusion `SyncWorker` already reached about call sync.
 */
object LocationSampler {

    private const val TAG = "iPropyLocation"

    /** How long to wait for a fix before giving up and trying again next time. */
    private const val WAIT_MS = 25_000L

    fun hasForegroundPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Whether the phone will give a position while the app is not open.
     *
     * On Android 10 and up this is a permission of its own, and it cannot be
     * asked for in a dialog — the person has to open Settings and choose "Allow
     * all the time". Below 10 the foreground grant covers both.
     */
    fun hasBackgroundPermission(context: Context): Boolean =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            hasForegroundPermission(context)
        } else {
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        }

    data class Fix(
        val latitude: Double,
        val longitude: Double,
        val recordedAt: Long,
        val accuracyM: Float?,
        val speedMps: Float?,
        val batteryPct: Int?,
    )

    /**
     * Ask for a position. Null when there is no permission, no provider or no fix.
     *
     * A null is completely ordinary — a basement, a lift, a phone with location
     * switched off at the system level — so nothing upstream treats it as a
     * failure worth retrying hard.
     */
    suspend fun sample(context: Context): Fix? {
        if (!hasForegroundPermission(context)) return null
        val manager = ContextCompat.getSystemService(context, LocationManager::class.java) ?: return null

        val location = currentLocation(context, manager) ?: lastKnown(manager)
        if (location == null) {
            Log.i(TAG, "no position available right now")
            return null
        }

        // A fix from a previous hour, handed over by the cache, is not where
        // somebody is now. Reporting it would draw a rep at a site they left.
        val age = System.currentTimeMillis() - location.time
        if (age > 20 * 60_000L) {
            Log.i(TAG, "last known position is ${age / 60_000} minutes old; skipping")
            return null
        }

        return Fix(
            latitude = location.latitude,
            longitude = location.longitude,
            recordedAt = location.time.takeIf { it > 0 } ?: System.currentTimeMillis(),
            accuracyM = if (location.hasAccuracy()) location.accuracy else null,
            speedMps = if (location.hasSpeed()) location.speed else null,
            batteryPct = batteryPercent(context),
        )
    }

    @Suppress("MissingPermission") // checked by the caller
    private suspend fun currentLocation(context: Context, manager: LocationManager): Location? {
        // A fresh fix, asked for once, cancelled by the timeout rather than
        // left running and draining the battery.
        //
        // `getCurrentLocation` arrived in API 30. Below that this returns null
        // and the caller falls back on the last known position, which the
        // twenty-minute age check then keeps honest — an older phone reports
        // less often rather than reporting somewhere the rep used to be.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val provider = when {
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> return null
        }

        return withTimeoutOrNull(WAIT_MS) {
            suspendCancellableCoroutine { continuation ->
                val signal = android.os.CancellationSignal()
                continuation.invokeOnCancellation { signal.cancel() }
                try {
                    manager.getCurrentLocation(
                        provider,
                        signal,
                        ContextCompat.getMainExecutor(context),
                    ) { location -> if (continuation.isActive) continuation.resume(location) }
                } catch (e: Exception) {
                    Log.w(TAG, "could not request a position", e)
                    if (continuation.isActive) continuation.resume(null)
                }
            }
        }
    }

    @Suppress("MissingPermission") // checked by the caller
    private fun lastKnown(manager: LocationManager): Location? = try {
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            .mapNotNull { provider ->
                if (manager.isProviderEnabled(provider)) manager.getLastKnownLocation(provider) else null
            }
            .maxByOrNull { it.time }
    } catch (e: Exception) {
        Log.w(TAG, "no last known position", e)
        null
    }

    /**
     * Battery level, sent alongside every fix.
     *
     * Because "their phone died" and "they switched it off" look identical on a
     * map, and only one of those is worth a conversation.
     */
    private fun batteryPercent(context: Context): Int? = try {
        val status = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = status?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = status?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        if (level >= 0 && scale > 0) (level * 100) / scale else null
    } catch (e: Exception) {
        null
    }
}
