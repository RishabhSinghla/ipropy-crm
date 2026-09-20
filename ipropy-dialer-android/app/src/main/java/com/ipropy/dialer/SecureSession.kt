package com.ipropy.dialer

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** The dialer owns a CRM session, never a copy of CRM data. */
class SecureSession(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "dialer_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var baseUrl: String?
        get() = prefs.getString("base_url", null)
        set(value) = prefs.edit().putString("base_url", value).apply()
    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()
    var displayName: String?
        get() = prefs.getString("display_name", null)
        set(value) = prefs.edit().putString("display_name", value).apply()

    fun clear() = prefs.edit().clear().apply()
}
