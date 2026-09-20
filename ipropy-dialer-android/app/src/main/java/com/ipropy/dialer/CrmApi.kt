package com.ipropy.dialer

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class DialerSession(val token: String, val name: String)
data class DialerRecord(
    val id: String,
    val module: String,
    val name: String,
    val phone: String,
    val status: String?,
    val followUp: String?,
)
data class CallResult(val callId: String)
data class StatusSchema(val fieldName: String, val values: List<String>)

/**
 * A thin client over the existing CRM API. Queue filtering, permissions and
 * field access are deliberately decided by CRM, not reimplemented on a phone.
 */
object CrmApi {
    private const val TIMEOUT = 30_000

    fun login(baseUrl: String, identifier: String, password: String): DialerSession {
        val body = JSONObject().put("identifier", identifier).put("password", password)
        val response = request(baseUrl, "/api/auth/login", "POST", body, null)
        return DialerSession(response.getString("token"), response.optJSONObject("user")?.let { userName(it) } ?: identifier)
    }

    fun queue(baseUrl: String, token: String, module: String): List<DialerRecord> {
        val sort = if (module == "leads") "next_followup_at" else "updated_at"
        val result = request(baseUrl, "/api/records/$module?page=1&pageSize=100&sortBy=$sort&sortDir=asc", "GET", null, token)
        val rows = result.optJSONArray("rows") ?: JSONArray()
        return buildList {
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                val values = row.optJSONObject("values") ?: JSONObject()
                val display = row.optJSONObject("display") ?: JSONObject()
                val phone = first(values, "mobile", "phone", "alternate_phone") ?: continue
                add(DialerRecord(
                    id = row.getString("id"), module = module,
                    name = first(display, "full_name", "name", "contact_name")
                        ?: first(values, "full_name", "name", "contact_name") ?: "Unnamed record",
                    phone = phone,
                    status = first(display, "status", "lead_status", "property_status") ?: first(values, "status", "lead_status", "property_status"),
                    followUp = first(display, "next_followup_at") ?: first(values, "next_followup_at"),
                ))
            }
        }
    }

    fun dispositions(baseUrl: String, token: String): List<String> {
        val response = requestArray(baseUrl, "/api/metadata/picklists/call_disposition", "GET", null, token)
        val values = mutableListOf<String>()
        for (i in 0 until response.length()) {
            val row = response.optJSONObject(i)
            val value = row?.optString("value")?.takeIf { it.isNotBlank() } ?: row?.optString("label")
            if (!value.isNullOrBlank()) values += value
        }
        return values
    }

    /** Reads the active status field from the CRM schema, never a hard-coded app list. */
    fun statusSchema(baseUrl: String, token: String, module: String): StatusSchema? {
        val moduleSchema = request(baseUrl, "/api/metadata/modules/$module", "GET", null, token)
        val fields = moduleSchema.optJSONArray("fields") ?: return null
        var fieldName: String? = null
        var picklist: String? = null
        for (i in 0 until fields.length()) {
            val field = fields.optJSONObject(i) ?: continue
            val config = field.optJSONObject("config")
            val name = field.optString("name")
            val list = config?.optString("picklist")
            if (name == "status" || list == "lead_status" || list == "property_status") {
                fieldName = name; picklist = list; break
            }
        }
        if (fieldName.isNullOrBlank() || picklist.isNullOrBlank()) return null
        return StatusSchema(fieldName, picklistValues(baseUrl, token, picklist))
    }

    fun updateRecord(baseUrl: String, token: String, record: DialerRecord, fieldName: String, value: String) {
        request(baseUrl, "/api/records/${record.module}/${record.id}", "PATCH", JSONObject().put(fieldName, value), token)
    }

    fun logCall(baseUrl: String, token: String, record: DialerRecord, durationSeconds: Int, disposition: String, notes: String): CallResult {
        val body = JSONObject()
            .put("to", record.phone)
            .put("direction", "outbound")
            .put("durationSeconds", durationSeconds.coerceAtLeast(0))
            .put("disposition", disposition)
            .put("notes", notes)
        if (record.id.isNotBlank() && record.module.isNotBlank()) {
            body.put("recordId", record.id).put("module", record.module)
        }
        val response = request(baseUrl, "/api/telephony/log", "POST", body, token)
        return CallResult(response.getString("callId"))
    }

    fun setDisposition(baseUrl: String, token: String, callId: String, disposition: String, notes: String, followUpAt: String?) {
        val body = JSONObject().put("disposition", disposition).put("notes", notes)
        if (followUpAt.isNullOrBlank()) body.put("followUpAt", JSONObject.NULL) else body.put("followUpAt", followUpAt)
        request(baseUrl, "/api/telephony/calls/$callId/disposition", "POST", body, token)
    }

    private fun request(baseUrl: String, path: String, method: String, body: JSONObject?, token: String?): JSONObject =
        JSONObject(requestText(baseUrl, path, method, body, token))

    private fun requestArray(baseUrl: String, path: String, method: String, body: JSONObject?, token: String?): JSONArray =
        JSONArray(requestText(baseUrl, path, method, body, token))

    private fun picklistValues(baseUrl: String, token: String, name: String): List<String> {
        val response = requestArray(baseUrl, "/api/metadata/picklists/$name", "GET", null, token)
        return buildList {
            for (i in 0 until response.length()) {
                val option = response.optJSONObject(i) ?: continue
                option.optString("value").takeIf { it.isNotBlank() }?.let { add(it) }
            }
        }
    }

    private fun requestText(baseUrl: String, path: String, method: String, body: JSONObject?, token: String?): String {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = TIMEOUT
        connection.readTimeout = TIMEOUT
        connection.setRequestProperty("Accept", "application/json")
        if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
        if (body != null) {
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val code = connection.responseCode
        val text = (if (code in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use { it.readText() }.orEmpty()
        connection.disconnect()
        if (code !in 200..299) {
            val message = runCatching { JSONObject(text).optString("message") }.getOrNull().orEmpty()
            throw IllegalStateException(message.ifBlank { "CRM request failed ($code)" })
        }
        return text.ifBlank { "{}" }
    }

    private fun first(objectValue: JSONObject, vararg keys: String): String? = keys
        .asSequence().mapNotNull { key -> objectValue.optString(key).takeIf { it.isNotBlank() && it != "null" } }.firstOrNull()
    private fun userName(user: JSONObject): String = listOf(user.optString("firstName"), user.optString("lastName"))
        .filter { it.isNotBlank() }.joinToString(" ").ifBlank { user.optString("email", "iPROPY user") }
}
