package com.ipropy.callsync

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * The whole network layer.
 *
 * Hand-rolled over HttpURLConnection rather than pulling in OkHttp/Retrofit:
 * this app makes exactly three requests, and every dependency added here is one
 * more thing that can break a build on a machine that is not set up for Android
 * development. Keeping it dependency-free is what makes this app installable by
 * someone who just wants their calls in the CRM.
 */
object Api {

    data class CallEntry(
        val externalId: String,
        val number: String,
        val type: Int,
        val timestamp: Long,
        val durationSeconds: Int,
        val contactName: String?,
    )

    data class SyncResult(val created: Int, val duplicates: Int, val matched: Int)

    private const val TAG = "iPropyApi"
    private const val TIMEOUT_MS = 30_000

    /** Confirms the token still works. Called before a sync so a revoked device fails loudly. */
    fun ping(baseUrl: String, token: String): Boolean = try {
        val connection = open(baseUrl, "/api/device/ping", "GET", token)
        val ok = connection.responseCode in 200..299
        connection.disconnect()
        ok
    } catch (e: Exception) {
        Log.w(TAG, "ping failed", e)
        false
    }

    fun syncCalls(
        baseUrl: String,
        token: String,
        entries: List<CallEntry>,
        appVersion: String,
    ): SyncResult? {
        if (entries.isEmpty()) return SyncResult(0, 0, 0)

        val array = JSONArray()
        for (entry in entries) {
            array.put(
                JSONObject().apply {
                    put("externalId", entry.externalId)
                    put("number", entry.number)
                    put("type", entry.type)
                    put("timestamp", entry.timestamp)
                    put("durationSeconds", entry.durationSeconds)
                    entry.contactName?.let { put("contactName", it) }
                },
            )
        }
        val payload = JSONObject().apply {
            put("appVersion", appVersion)
            put("entries", array)
        }

        return try {
            val connection = open(baseUrl, "/api/device/calls", "POST", token)
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            connection.outputStream.use { it.write(payload.toString().toByteArray()) }

            if (connection.responseCode !in 200..299) {
                Log.w(TAG, "sync rejected: ${connection.responseCode}")
                connection.disconnect()
                return null
            }
            val body = JSONObject(connection.inputStream.bufferedReader().readText())
            connection.disconnect()
            SyncResult(
                body.optInt("created"),
                body.optInt("duplicates"),
                body.optInt("matched"),
            )
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            null
        }
    }

    /**
     * Multipart upload, written out by hand.
     *
     * Streamed from the file rather than read into a byte array: a long call
     * recording on a low-end phone is exactly where an OutOfMemoryError would
     * come from.
     */
    fun uploadRecording(
        context: Context,
        baseUrl: String,
        token: String,
        externalId: String,
        candidate: RecordingFinder.Candidate,
    ): Boolean = try {
        val boundary = "----ipropy${System.currentTimeMillis()}"
        val connection = open(baseUrl, "/api/device/recordings", "POST", token)
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        connection.doOutput = true
        connection.setChunkedStreamingMode(16 * 1024)

        DataOutputStream(connection.outputStream).use { out ->
            out.writeBytes("--$boundary\r\n")
            out.writeBytes("Content-Disposition: form-data; name=\"externalId\"\r\n\r\n")
            out.writeBytes("$externalId\r\n")

            out.writeBytes("--$boundary\r\n")
            out.writeBytes(
                "Content-Disposition: form-data; name=\"audio\"; filename=\"${safeFileName(candidate.name)}\"\r\n",
            )
            out.writeBytes("Content-Type: ${mimeFor(candidate.name)}\r\n\r\n")
            val input = context.contentResolver.openInputStream(candidate.uri)
                ?: return false
            input.use { it.copyTo(out) }
            out.writeBytes("\r\n--$boundary--\r\n")
        }

        val code = connection.responseCode
        val responseBody = try {
            (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
        } catch (_: Exception) {
            ""
        }
        // The server deliberately returns HTTP 200 with ok:false when the call
        // row has not arrived yet. Only remember the file after a real attach.
        val ok = code in 200..299 && runCatching {
            JSONObject(responseBody).optBoolean("ok", false)
        }.getOrDefault(false)
        connection.disconnect()
        ok
    } catch (e: Exception) {
        Log.w(TAG, "recording upload failed", e)
        false
    }

    private fun open(baseUrl: String, path: String, method: String, token: String): HttpURLConnection {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.setRequestProperty("Authorization", "Bearer $token")
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        return connection
    }

    private fun mimeFor(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp3" -> "audio/mpeg"
        "m4a", "mp4" -> "audio/mp4"
        "amr" -> "audio/amr"
        "wav" -> "audio/wav"
        "ogg" -> "audio/ogg"
        "aac" -> "audio/aac"
        "3gp" -> "audio/3gpp"
        else -> "audio/mpeg"
    }

    private fun safeFileName(name: String): String =
        name.replace(Regex("[\\r\\n\\\"]"), "_").take(180)
}
