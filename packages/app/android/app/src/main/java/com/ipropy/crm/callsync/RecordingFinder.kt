package com.ipropy.crm.callsync

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile

/**
 * Finds call recordings the phone's own recorder wrote.
 *
 * Android 10 closed the third-party call-recording API, and no amount of
 * permissions reopens it. What still works — and what every CRM that claims
 * call recording on Android actually does — is reading the files the *OEM's*
 * recorder produces. Xiaomi, Realme, Samsung, OnePlus, Vivo and Oppo all ship
 * one, but modern Android deliberately hides those folders from broad storage
 * scans. The user therefore grants this app one recording folder through the
 * system picker. That grant survives reboot and exposes nothing else.
 *
 * That naming is the join key, and it is genuinely fragile: it varies by
 * manufacturer and changes between OS versions. So matching is deliberately
 * loose — last ten digits of the number, and a timestamp within a window — and
 * an unmatched file is simply left alone rather than uploaded against a guess.
 * Attaching a recording to the wrong call would be far worse than attaching
 * none.
 */
object RecordingFinder {

    private const val TAG = "iPropyRecordings"

    private val AUDIO_EXTENSIONS = setOf("mp3", "m4a", "amr", "wav", "ogg", "aac", "3gp")

    /** How far a file's modified time may sit from the call and still be the same call. */
    private const val MATCH_WINDOW_MS = 5 * 60 * 1000L

    private const val MAX_FILES = 500
    private const val MAX_DEPTH = 3

    data class Candidate(
        val uri: Uri,
        val name: String,
        /** Every digit in the file name, in order — the number is somewhere in here. */
        val digits: String,
        val modifiedAt: Long,
        val size: Long,
    ) {
        val stableId: String get() = "$uri:$size:$modifiedAt"
    }

    fun scan(context: Context, treeUri: String?): List<Candidate> {
        if (treeUri.isNullOrBlank()) return emptyList()
        val root = try {
            DocumentFile.fromTreeUri(context, Uri.parse(treeUri))
        } catch (e: Exception) {
            Log.w(TAG, "recording folder grant is no longer valid", e)
            null
        } ?: return emptyList()
        val found = mutableListOf<Candidate>()
        fun walk(directory: DocumentFile, depth: Int) {
            if (depth > MAX_DEPTH || found.size >= MAX_FILES) return
            val children = try {
                directory.listFiles().sortedByDescending { it.lastModified() }
            } catch (e: Exception) {
                Log.w(TAG, "cannot read selected recording folder", e)
                return
            }
            for (file in children) {
                if (found.size >= MAX_FILES) return
                if (file.isDirectory) {
                    walk(file, depth + 1)
                    continue
                }
                val name = file.name ?: continue
                if (name.substringAfterLast('.', "").lowercase() !in AUDIO_EXTENSIONS) continue
                found.add(
                    Candidate(
                        uri = file.uri,
                        name = name,
                        digits = name.filter { it.isDigit() },
                        modifiedAt = file.lastModified(),
                        size = file.length(),
                    ),
                )
            }
        }
        walk(root, 0)
        return found.sortedByDescending { it.modifiedAt }
    }

    /**
     * Match a recording to a call.
     *
     * Requires *both* the number and the time to agree. Either alone produces
     * confident wrong answers: two calls to the same lead in an afternoon, or
     * two different people called a minute apart.
     */
    fun matchTo(candidate: Candidate, call: Api.CallEntry): Boolean {
        /*
          Is the call's own number inside the file name? Asked this way round
          on 29 September 2026. It used to *extract* a number from the name,
          after first deleting the underscores — which glued the number to the
          date in the most common naming of all, "9876543210_20260929101010",
          read it as "929101010", and matched nothing. Every recording named
          that way stayed on the phone. Looking for a number we already know
          cannot be fooled by what sits either side of it.
        */
        val callDigits = call.number.filter { it.isDigit() }.takeLast(10)
        if (callDigits.length < 7 || !candidate.digits.contains(callDigits)) return false
        val callEnd = call.timestamp + call.durationSeconds * 1000L
        return kotlin.math.abs(candidate.modifiedAt - callEnd) <= MATCH_WINDOW_MS ||
            kotlin.math.abs(candidate.modifiedAt - call.timestamp) <= MATCH_WINDOW_MS
    }
}
