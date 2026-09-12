package com.ipropy.crm.callsync

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.os.Build
import android.os.Bundle
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


    /**
     * Ask the call log for at most `limit` rows.
     *
     * The obvious way to write this — a row cap appended to the sort order —
     * is what the standalone companion app does, and on Android 11 and newer
     * the call-log provider refuses it outright with
     * IllegalArgumentException: Invalid token.
     *
     * The provider validates the sort order in strict mode now, and a row cap
     * is not a sort order. Nothing about this is visible from the app's side
     * except an exception in a catch block, and both of this class's callers
     * catch and carry on — so the failure is a handset that pairs, reports
     * itself healthy, and uploads not one call, ever.
     *
     * The second half of the same bug is quieter and worse. `currentHighestId`
     * runs this too, and its failure returns 0, which the pairing code reads as
     * start from the beginning of the call log. A rep who deliberately left
     * bring-across-existing-calls switched off would have had their whole
     * personal call history uploaded the moment the read alone was fixed.
     *
     * `QUERY_ARG_LIMIT` is the supported way and exists from API 30, which is
     * exactly where the restriction bites. Below that the old form still works
     * and is still used, because the argument is ignored there.
     */
    private fun queryCalls(
        context: Context,
        projection: Array<String>,
        selection: String?,
        selectionArgs: Array<String>?,
        order: String,
        limit: Int,
    ): Cursor? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val args = Bundle().apply {
                if (selection != null) {
                    putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
                    putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selectionArgs)
                }
                putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order)
                putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
            }
            return context.contentResolver.query(CallLog.Calls.CONTENT_URI, projection, args, null)
        }
        return context.contentResolver.query(
            CallLog.Calls.CONTENT_URI, projection, selection, selectionArgs, "$order LIMIT $limit",
        )
    }

    fun read(context: Context, sinceId: Long, limit: Int): Batch {
        val entries = mutableListOf<Api.CallEntry>()

        val cursor: Cursor? = try {
            queryCalls(
                context,
                PROJECTION,
                if (sinceId > 0) "${CallLog.Calls._ID} > ?" else null,
                if (sinceId > 0) arrayOf(sinceId.toString()) else null,
                // Ascending so a partial batch always advances the watermark to a
                // contiguous point — descending would leave a hole in the middle.
                "${CallLog.Calls._ID} ASC",
                limit,
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

    /**
     * The newest call already on this phone, or null if the log could not be read.
     *
     * The distinction is the whole point and it used to be thrown away. This
     * returned 0 both when the call log was genuinely empty and when the query
     * failed, and the caller reads 0 as "start from the beginning" — so a
     * failure here silently converts *do not bring across my old calls* into
     * *upload all of them*. A rep's personal call history ending up in their
     * employer's CRM must not be the fallback behaviour of a caught exception.
     */
    fun currentHighestId(context: Context): Long? = try {
        queryCalls(context, arrayOf(CallLog.Calls._ID), null, null, "${CallLog.Calls._ID} DESC", 1)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L }
    } catch (e: Exception) {
        Log.w(TAG, "could not read the call-log watermark", e)
        null
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
            queryCalls(context, PROJECTION, null, null, "${CallLog.Calls.DATE} DESC", limit)
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
