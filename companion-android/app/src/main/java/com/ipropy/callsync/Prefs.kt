package com.ipropy.callsync

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Local state.
 *
 * The device token is a long-lived credential that can read every call this
 * person makes, so it lives in EncryptedSharedPreferences behind the Android
 * keystore rather than in plain preferences. Non-secret sync state lives in a
 * normal private preference file; if secure storage is unavailable, pairing is
 * disabled rather than silently writing the bearer token in plaintext.
 */
class Prefs(context: Context) {

    private val state: SharedPreferences = context.getSharedPreferences("ipropy-state", Context.MODE_PRIVATE)
    private val secure: SharedPreferences? = try {
        EncryptedSharedPreferences.create(
            context,
            "ipropy-secure",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        null
    }

    val secureStorageAvailable: Boolean get() = secure != null

    var baseUrl: String?
        get() = state.getString(KEY_BASE_URL, null)
        set(value) = state.edit().putString(KEY_BASE_URL, value?.trim()?.trimEnd('/')).apply()

    var token: String?
        get() = secure?.getString(KEY_TOKEN, null)
        set(value) {
            val storage = secure ?: throw IllegalStateException("Android secure storage is unavailable")
            storage.edit().putString(KEY_TOKEN, value?.trim()).apply()
        }

    /** Watermark: the highest call-log id already sent. */
    var lastCallId: Long
        get() = state.getLong(KEY_LAST_CALL_ID, 0L)
        set(value) = state.edit().putLong(KEY_LAST_CALL_ID, value).apply()

    var watermarkInitialised: Boolean
        get() = state.getBoolean(KEY_WATERMARK_INITIALISED, false)
        set(value) = state.edit().putBoolean(KEY_WATERMARK_INITIALISED, value).apply()

    var importExistingHistory: Boolean
        get() = state.getBoolean(KEY_IMPORT_HISTORY, false)
        set(value) = state.edit().putBoolean(KEY_IMPORT_HISTORY, value).apply()

    var lastSyncAt: Long
        get() = state.getLong(KEY_LAST_SYNC_AT, 0L)
        set(value) = state.edit().putLong(KEY_LAST_SYNC_AT, value).apply()

    var lastSyncSummary: String?
        get() = state.getString(KEY_LAST_SUMMARY, null)
        set(value) = state.edit().putString(KEY_LAST_SUMMARY, value).apply()

    var uploadRecordings: Boolean
        get() = state.getBoolean(KEY_UPLOAD_RECORDINGS, false)
        set(value) = state.edit().putBoolean(KEY_UPLOAD_RECORDINGS, value).apply()

    var recordingTreeUri: String?
        get() = state.getString(KEY_RECORDING_TREE, null)
        set(value) = state.edit().putString(KEY_RECORDING_TREE, value).apply()

    /**
     * Stable document identifiers already uploaded. Trimmed rather than left to grow without
     * bound — a phone that has recorded for two years would otherwise carry a
     * multi-megabyte preference it re-reads on every sync.
     */
    var uploadedRecordings: Set<String>
        get() = state.getStringSet(KEY_UPLOADED, emptySet()) ?: emptySet()
        set(value) {
            val trimmed = if (value.size > MAX_REMEMBERED) value.toList().takeLast(MAX_REMEMBERED).toSet() else value
            state.edit().putStringSet(KEY_UPLOADED, trimmed).apply()
        }

    val isPaired: Boolean get() = !baseUrl.isNullOrBlank() && !token.isNullOrBlank()

    fun clear() {
        state.edit().clear().apply()
        secure?.edit()?.clear()?.apply()
    }

    private companion object {
        const val KEY_BASE_URL = "base_url"
        const val KEY_TOKEN = "token"
        const val KEY_LAST_CALL_ID = "last_call_id"
        const val KEY_WATERMARK_INITIALISED = "watermark_initialised"
        const val KEY_IMPORT_HISTORY = "import_history"
        const val KEY_LAST_SYNC_AT = "last_sync_at"
        const val KEY_LAST_SUMMARY = "last_summary"
        const val KEY_UPLOAD_RECORDINGS = "upload_recordings"
        const val KEY_RECORDING_TREE = "recording_tree"
        const val KEY_UPLOADED = "uploaded_recordings"
        const val MAX_REMEMBERED = 500
    }
}
