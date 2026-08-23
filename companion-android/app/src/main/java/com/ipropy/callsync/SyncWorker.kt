package com.ipropy.callsync

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The background sync.
 *
 * WorkManager rather than a foreground service or an alarm: it survives reboot,
 * respects Doze, and is the only scheduling API that Xiaomi's and Oppo's
 * aggressive battery managers reliably honour. A foreground service would show
 * a permanent notification and still get killed on those devices.
 *
 * Every run is safe to repeat. The server dedupes, so a retry after a dropped
 * connection costs bandwidth and nothing else — which is what lets this be
 * `Result.retry()` on any failure without reasoning about partial state.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        val baseUrl = prefs.baseUrl
        val token = prefs.token

        if (baseUrl.isNullOrBlank() || token.isNullOrBlank()) {
            Log.i(TAG, "not paired yet — nothing to sync")
            return Result.success()
        }

        return try {
            var totalCreated = 0

            // Paged so a first-run backfill of years of history does not become
            // one enormous request that times out and retries forever.
            for (page in 0 until MAX_PAGES) {
                val since = prefs.lastCallId
                val batch = CallLogReader.read(applicationContext, since, BATCH_SIZE)
                if (batch.failed) return Result.failure()
                if (batch.lastSeenId <= since) break

                val result = Api.syncCalls(baseUrl, token, batch.entries, BuildConfigCompat.versionName)
                    ?: return Result.retry()

                // Advance over every row inspected, including private/withheld
                // numbers that are intentionally not uploaded. Otherwise a run
                // of private calls can pin the cursor forever.
                prefs.lastCallId = batch.lastSeenId
                totalCreated += result.created

                if (batch.scanned < BATCH_SIZE) break
            }

            if (prefs.uploadRecordings) {
                uploadRecordings(prefs, baseUrl, token)
            }

            // Position last, so a slow or absent fix can never delay the calls
            // reaching the CRM. Its own try/catch for the same reason.
            runCatching { syncLocation(prefs, baseUrl, token) }
                .onFailure { Log.w(TAG, "location step failed", it) }

            prefs.lastSyncAt = System.currentTimeMillis()
            prefs.lastSyncSummary = "Synced $totalCreated new call${if (totalCreated == 1) "" else "s"}"
            Log.i(TAG, "sync complete: $totalCreated new")
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            prefs.lastSyncSummary = "Sync failed: ${e.message}"
            Result.retry()
        }
    }

    /**
     * Take a position if the CRM wants one, and send whatever is queued.
     *
     * **Every decision here belongs to the CRM, not the app.** Whether to record
     * at all, how often, and whether right now is inside working hours are all
     * answered by `/api/device/policy`. The app is the hardest thing in this
     * system to change — a rebuild, a re-install, and somebody holding the
     * handset — so a rep on last month's version still has to be switchable
     * from the admin panel.
     *
     * The cached answer is used when the policy cannot be fetched, and the
     * cache defaults to off. Failing closed is the only safe direction for a
     * setting about recording where people are.
     */
    private suspend fun syncLocation(prefs: Prefs, baseUrl: String, token: String) {
        val policy = Api.fetchPolicy(baseUrl, token)
        if (policy != null) {
            prefs.locationEnabled = policy.enabled
            prefs.locationEveryMinutes = policy.everyMinutes
        }
        if (!prefs.locationEnabled) {
            // Nothing to send, and anything already queued is now unwanted.
            if (prefs.pendingFixes != "[]") prefs.pendingFixes = "[]"
            return
        }
        // A null policy means the question could not be asked. Keep queueing on
        // the cached interval rather than guessing about the hours.
        if (policy != null && !policy.withinHours) return

        val due = System.currentTimeMillis() - prefs.lastFixAt >= prefs.locationEveryMinutes * 60_000L
        if (due) {
            LocationSampler.sample(applicationContext)?.let { fix ->
                prefs.lastFixAt = System.currentTimeMillis()
                queue(prefs, fix)
            }
        }

        val pending = prefs.pendingFixes
        if (pending == "[]") return
        val result = Api.syncLocations(baseUrl, token, pending)
        when {
            // Sent, or refused because recording is off. Either way the queue
            // has done its job and holding it would only grow it.
            result != null -> {
                prefs.pendingFixes = "[]"
                if (result.reason != null) {
                    prefs.locationEnabled = false
                    Log.i(TAG, "location recording is off: ${result.reason}")
                }
            }
            // No network. Keep them for the next wake.
            else -> Log.i(TAG, "could not send positions; keeping them queued")
        }
    }

    /** Add one fix to the queue, oldest dropped first if it has grown too long. */
    private fun queue(prefs: Prefs, fix: LocationSampler.Fix) {
        val array = runCatching { JSONArray(prefs.pendingFixes) }.getOrElse { JSONArray() }
        array.put(
            JSONObject().apply {
                put("latitude", fix.latitude)
                put("longitude", fix.longitude)
                put("recordedAt", fix.recordedAt)
                fix.accuracyM?.let { put("accuracyM", it.toDouble()) }
                fix.speedMps?.let { put("speedMps", it.toDouble()) }
                fix.batteryPct?.let { put("batteryPct", it) }
            },
        )
        // A handset offline for a week would otherwise carry a preference file
        // it re-reads on every wake. The oldest points are the least useful.
        val trimmed = if (array.length() > MAX_QUEUED_FIXES) {
            JSONArray().also { out ->
                for (i in (array.length() - MAX_QUEUED_FIXES) until array.length()) out.put(array.get(i))
            }
        } else {
            array
        }
        prefs.pendingFixes = trimmed.toString()
    }

    /**
     * Recordings are matched against the calls we just read, then uploaded once.
     *
     * The set of already-uploaded files is kept locally rather than asked for,
     * because the alternative is an extra round trip per file on every run.
     */
    private fun uploadRecordings(prefs: Prefs, baseUrl: String, token: String) {
        val uploaded = prefs.uploadedRecordings.toMutableSet()
        val candidates = RecordingFinder.scan(applicationContext, prefs.recordingTreeUri)
            .filter { it.stableId !in uploaded }
            .filter { it.size > MIN_RECORDING_BYTES }
        if (candidates.isEmpty()) return

        // Match against recent calls only. A recording folder can hold years of
        // files, and the ones worth matching are the ones from calls that just
        // happened — anything older either matched on a previous run or never
        // will.
        val recent = CallLogReader.readRecent(applicationContext, RECENT_CALLS)

        for (candidate in candidates.take(MAX_UPLOADS_PER_RUN)) {
            val call = recent.firstOrNull { RecordingFinder.matchTo(candidate, it) } ?: continue
            if (Api.uploadRecording(applicationContext, baseUrl, token, call.externalId, candidate)) {
                uploaded.add(candidate.stableId)
            }
        }
        prefs.uploadedRecordings = uploaded
    }

    companion object {
        private const val TAG = "iPropySync"
        private const val WORK_NAME = "ipropy-call-sync"
        private const val BATCH_SIZE = 400
        private const val MAX_PAGES = 25
        private const val RECENT_CALLS = 200
        private const val MAX_UPLOADS_PER_RUN = 10
        private const val MAX_QUEUED_FIXES = 200

        /** Anything shorter is almost always a truncated or failed recording. */
        private const val MIN_RECORDING_BYTES = 8 * 1024L

        /**
         * Fifteen minutes is WorkManager's floor for periodic work. Calls are
         * not urgent enough to justify fighting that, and a rep who wants their
         * last call in the CRM right now has "Sync now".
         */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                // KEEP, so re-opening the app does not reset the schedule and
                // push the next run fifteen minutes out every time.
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}

/**
 * The app's version, read from the one place that defines it.
 *
 * This used to be a hand-typed copy of the number in `build.gradle.kts`, which
 * is two places to change and one of them gets forgotten. The CRM shows this
 * string in Settings → Phones, so a stale copy means a handset reports a
 * version it is not running.
 */
object BuildConfigCompat {
    val versionName: String = BuildConfig.VERSION_NAME
}
