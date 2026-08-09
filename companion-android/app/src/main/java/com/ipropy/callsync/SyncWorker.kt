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

/** Kept separate so the worker does not depend on a generated BuildConfig class. */
object BuildConfigCompat {
    const val versionName: String = "1.0.0"
}
