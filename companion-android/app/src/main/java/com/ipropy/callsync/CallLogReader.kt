package com.ipropy.callsync

import android.content.Context
import android.database.Cursor
import android.provider.CallLog
import android.util.Log

/**
 * Reads the system call log.
 *
 * The watermark is the last call *id* we sent, not a timestamp. Timestamps are
 * not reliable here — a phone that changes timezone, or whose clock corrects
 * itself over NTP, can write a row "before" one already synced, and a
 * timestamp-based cursor would skip it forever. Ids are monotonic within a
 * device's call log, which is exactly the property needed.
 *
 * The server dedupes on (device_id, external_id) regardless, so the worst case
 * of a wrong watermark is wasted bandwidth, never a duplicate call.
 */
object CallLogReader {

    private const val TAG = "iPropyCallLog"

    private val PROJECTION = arrayOf(
        CallLog.Calls._ID,
        CallLog.Calls.NUMBER,
        CallLog.Calls.TYPE,
        CallLog.Calls.DATE,
        CallLog.Calls.DURATION,
        CallLog.Calls.CACHED_NAME,
    )

    data class Batch(
        val entries: List<Api.CallEntry>,
        val lastSeenId: Long,
        val scanned: Int,
        val failed: Boolean = false,
    )

    fun read(context: Context, sinceId: Long, limit: Int): Batch {
        val entries = mutableListOf<Api.CallEntry>()

        val cursor: Cursor? = try {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                PROJECTION,
                if (sinceId > 0) "${CallLog.Calls._ID} > ?" else null,
                if (sinceId > 0) arrayOf(sinceId.toString()) else null,
                // Ascending so a partial batch always advances the watermark to a
                // contiguous point — descending would leave a hole in the middle.
                "${CallLog.Calls._ID} ASC LIMIT $limit",
            )
        } catch (e: SecurityException) {
            Log.w(TAG, "call log permission not granted", e)
            return Batch(emptyList(), sinceId, 0, failed = true)
        } catch (e: Exception) {
            Log.w(TAG, "call log query failed", e)
            return Batch(emptyList(), sinceId, 0, failed = true)
        }

        var lastSeenId = sinceId
        var scanned = 0
        cursor?.use {
            val idIndex = it.getColumnIndex(CallLog.Calls._ID)
            val numberIndex = it.getColumnIndex(CallLog.Calls.NUMBER)
            val typeIndex = it.getColumnIndex(CallLog.Calls.TYPE)
            val dateIndex = it.getColumnIndex(CallLog.Calls.DATE)
            val durationIndex = it.getColumnIndex(CallLog.Calls.DURATION)
            val nameIndex = it.getColumnIndex(CallLog.Calls.CACHED_NAME)

            while (it.moveToNext()) {
                val rowId = it.getLong(idIndex)
                lastSeenId = maxOf(lastSeenId, rowId)
                scanned++
                val number = it.getString(numberIndex) ?: continue
                // Withheld numbers come through as "" or "-1"; there is nothing
                // to match them against, so they are not worth a round trip.
                if (number.isBlank() || number == "-1") continue

                entries.add(
                    Api.CallEntry(
                        externalId = rowId.toString(),
                        number = number,
                        type = it.getInt(typeIndex),
                        timestamp = it.getLong(dateIndex),
                        durationSeconds = it.getInt(durationIndex),
                        contactName = if (nameIndex >= 0) it.getString(nameIndex) else null,
                    ),
                )
            }
        }

        return Batch(entries, lastSeenId, scanned)
    }

    fun currentHighestId(context: Context): Long = try {
        context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls._ID),
            null,
            null,
            "${CallLog.Calls._ID} DESC LIMIT 1",
        )?.use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L } ?: 0L
    } catch (e: Exception) {
        Log.w(TAG, "could not initialise call-log watermark", e)
        0L
    }

    /**
     * The most recent N calls, newest first.
     *
     * Used only for matching recordings to calls, which is why it ignores the
     * watermark — a recording can land minutes after its call was already
     * synced, so the rows it needs to match against are behind the cursor.
     */
    fun readRecent(context: Context, limit: Int): List<Api.CallEntry> {
        val entries = mutableListOf<Api.CallEntry>()

        val cursor: Cursor? = try {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                PROJECTION,
                null,
                null,
                "${CallLog.Calls.DATE} DESC LIMIT $limit",
            )
        } catch (e: Exception) {
            Log.w(TAG, "recent call query failed", e)
            return emptyList()
        }

        cursor?.use {
            val idIndex = it.getColumnIndex(CallLog.Calls._ID)
            val numberIndex = it.getColumnIndex(CallLog.Calls.NUMBER)
            val typeIndex = it.getColumnIndex(CallLog.Calls.TYPE)
            val dateIndex = it.getColumnIndex(CallLog.Calls.DATE)
            val durationIndex = it.getColumnIndex(CallLog.Calls.DURATION)
            val nameIndex = it.getColumnIndex(CallLog.Calls.CACHED_NAME)

            while (it.moveToNext()) {
                val number = it.getString(numberIndex) ?: continue
                if (number.isBlank() || number == "-1") continue
                entries.add(
                    Api.CallEntry(
                        externalId = it.getLong(idIndex).toString(),
                        number = number,
                        type = it.getInt(typeIndex),
                        timestamp = it.getLong(dateIndex),
                        durationSeconds = it.getInt(durationIndex),
                        contactName = if (nameIndex >= 0) it.getString(nameIndex) else null,
                    ),
                )
            }
        }
        return entries
    }

    /** Highest id in this batch, so the watermark only advances over sent rows. */
    fun highestId(entries: List<Api.CallEntry>): Long =
        entries.mapNotNull { it.externalId.toLongOrNull() }.maxOrNull() ?: 0L
}
