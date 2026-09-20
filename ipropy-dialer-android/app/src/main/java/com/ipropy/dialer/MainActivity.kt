package com.ipropy.dialer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * iPROPY Dialer is intentionally a separate Android app. It reads the live CRM
 * queue and writes outcomes through the CRM API; it does not replace the CRM
 * web-to-phone call command or the existing Call Sync application.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var session: SecureSession
    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private val queue = mutableListOf<DialerRecord>()
    private var position = 0
    private var queueModule = "leads"
    private var powerMode = true
    private var dispositions = listOf("Connected", "Did not pick", "Call Back Later", "Wrong Number")
    private var statusSchema: StatusSchema? = null
    private var callStartedAt = 0L
    private var awaitingCallReturn = false

    private val callPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) beginCall() else toast("Phone-call permission is needed to dial from iPROPY Dialer.")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = SecureSession(this)
        render()
    }

    private fun render() {
        val scroll = ScrollView(this)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(28))
            setBackgroundColor(Color.rgb(247, 243, 251))
        }
        scroll.addView(content)
        setContentView(scroll)
        if (session.token.isNullOrBlank()) renderSignIn() else renderQueue()
    }

    override fun onResume() {
        super.onResume()
        val record = pendingRecord
        // The system Phone app owns the call screen. Only show the CRM outcome
        // sheet after the rep has returned here, never on top of an active call.
        if (awaitingCallReturn && record != null && System.currentTimeMillis() - callStartedAt > 1_000) {
            awaitingCallReturn = false
            showOutcome(record)
        }
    }

    private fun renderSignIn() {
        header("iPROPY Dialer", "A separate calling workspace for your CRM queue")
        card {
            addView(label("Sign in to your CRM"))
            val url = input("CRM address", session.baseUrl ?: "https://crm.ipropy.com")
            val identifier = input("Email or mobile", "")
            val password = input("Password", "", password = true)
            addView(button("Sign in and open dialer") {
                val baseUrl = url.text.toString().trim().trimEnd('/')
                if (!baseUrl.startsWith("https://") || identifier.text.isBlank() || password.text.isBlank()) {
                    toast("Enter your secure CRM address, email/mobile and password.")
                    return@button
                }
                it.isEnabled = false
                lifecycleScope.launch {
                    runCatching { withContext(Dispatchers.IO) { CrmApi.login(baseUrl, identifier.text.toString(), password.text.toString()) } }
                        .onSuccess { login ->
                            session.baseUrl = baseUrl; session.token = login.token; session.displayName = login.name
                            render()
                        }
                        .onFailure { error -> toast(error.message ?: "Could not sign in to CRM") }
                    it.isEnabled = true
                }
            })
            addView(note("This app stores only an encrypted CRM session. Lead and inventory data stays in iPROPY CRM."))
        }
    }

    private fun renderQueue() {
        header("iPROPY Dialer", "Hi ${session.displayName ?: "there"} · ${if (powerMode) "Power dial" else "Manual call"}")
        status = note("Loading your CRM queue…")
        content.addView(status)

        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        controls.addView(button("Leads") { queueModule = "leads"; reloadQueue() }, weighted())
        controls.addView(button("Inventory") { queueModule = "properties"; reloadQueue() }, weighted())
        controls.addView(button(if (powerMode) "Power" else "Manual") { powerMode = !powerMode; renderQueue() }, weighted())
        content.addView(controls)

        card {
            val manual = input("Manual number", "")
            addView(manual)
            addView(button("Call number") { dialManual(manual.text.toString()) })
        }
        content.addView(space(8))
        reloadQueue()
    }

    private fun reloadQueue() {
        status.text = "Refreshing ${if (queueModule == "leads") "Lead" else "Inventory"} queue from CRM…"
        lifecycleScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    val base = requireNotNull(session.baseUrl); val token = requireNotNull(session.token)
                    val records = CrmApi.queue(base, token, queueModule)
                    val choices = CrmApi.dispositions(base, token)
                    Triple(records, choices, CrmApi.statusSchema(base, token, queueModule))
                }
            }
            result.onSuccess { (records, choices, schema) ->
                queue.clear(); queue.addAll(records); position = 0
                if (choices.isNotEmpty()) dispositions = choices
                statusSchema = schema
                showCurrent()
            }.onFailure { error ->
                status.text = "Could not load the queue: ${error.message ?: "try again"}"
            }
        }
    }

    private fun showCurrent() {
        while (content.childCount > 4) content.removeViewAt(4)
        if (queue.isEmpty()) {
            status.text = "No callable ${if (queueModule == "leads") "leads" else "inventory records"} in your CRM view."
            return
        }
        position = position.coerceIn(0, queue.lastIndex)
        val current = queue[position]
        status.text = "${position + 1} of ${queue.size} · Live CRM queue"
        card {
            addView(label(current.name, 24))
            addView(note(current.phone))
            addView(note(listOfNotNull(current.status?.let { "Status: $it" }, current.followUp?.let { "Follow-up: $it" }).joinToString(" · ").ifBlank { "No status or follow-up" }))
            val navigation = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL }
            navigation.addView(button("‹ Previous") { if (position > 0) { position--; showCurrent() } }, weighted())
            navigation.addView(button("Call now") { dialRecord(current) }, weighted())
            navigation.addView(button("Next ›") { if (position < queue.lastIndex) { position++; showCurrent() } }, weighted())
            addView(navigation)
            addView(note("After the call, select the real CRM disposition and follow-up. Power dial then moves to the next record."))
        }
        content.addView(space(14))
        content.addView(button("Refresh queue") { reloadQueue() })
        content.addView(space(6))
        content.addView(button("Sign out") { session.clear(); render() })
    }

    private fun dialRecord(record: DialerRecord) {
        pendingRecord = record
        requestOrCall()
    }

    private fun dialManual(value: String) {
        val number = value.trim()
        if (number.length < 6) { toast("Enter a valid phone number."); return }
        pendingRecord = DialerRecord("", "", "Manual call", number, null, null)
        requestOrCall()
    }

    private var pendingRecord: DialerRecord? = null

    private fun requestOrCall() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) beginCall()
        else callPermission.launch(Manifest.permission.CALL_PHONE)
    }

    private fun beginCall() {
        val record = pendingRecord ?: return
        callStartedAt = System.currentTimeMillis()
        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:${Uri.encode(record.phone)}")))
            awaitingCallReturn = true
            toast("When you finish, return here to save the call result.")
        } catch (_: Exception) {
            toast("This phone cannot start the call. Choose a phone app that can place calls.")
        }
    }

    private fun showOutcome(record: DialerRecord) {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(8), dp(22), 0) }
        val outcome = Spinner(this)
        outcome.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, dispositions)
        val followUp = TextView(this).apply { text = "No follow-up scheduled"; setPadding(0, dp(12), 0, dp(12)) }
        var followUpAt: String? = null
        val notes = EditText(this).apply { hint = "Call notes (optional)"; minLines = 3; gravity = Gravity.TOP }
        val crmStatus = Spinner(this)
        val statuses = listOf("Keep current status") + (statusSchema?.values ?: emptyList())
        crmStatus.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, statuses)
        box.addView(label("Call result")); box.addView(outcome)
        box.addView(button("Set next follow-up") {
            val day = Calendar.getInstance()
            android.app.DatePickerDialog(this, { _, year, month, date ->
                followUpAt = String.format(Locale.US, "%04d-%02d-%02dT09:00:00.000Z", year, month + 1, date)
                followUp.text = "Follow-up: ${date}/${month + 1}/$year"
            }, day.get(Calendar.YEAR), day.get(Calendar.MONTH), day.get(Calendar.DAY_OF_MONTH)).show()
        })
        box.addView(followUp); box.addView(label("Update ${if (record.module == "properties") "Inventory" else "Lead"} status")); box.addView(crmStatus); box.addView(notes)
        AlertDialog.Builder(this)
            .setTitle("Save call result")
            .setView(box)
            .setNegativeButton("Not saved", null)
            .setPositiveButton("Save to CRM", null)
            .create().also { dialog ->
                dialog.setOnShowListener {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val selected = outcome.selectedItem?.toString() ?: return@setOnClickListener
                        val selectedStatus = crmStatus.selectedItem?.toString()
                        val elapsed = ((System.currentTimeMillis() - callStartedAt) / 1000).toInt()
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                        lifecycleScope.launch {
                            val saved = runCatching {
                                withContext(Dispatchers.IO) {
                                    val base = requireNotNull(session.baseUrl); val token = requireNotNull(session.token)
                                    CrmApi.logCall(base, token, record, elapsed, selected, notes.text.toString())
                                }
                            }
                            saved.onSuccess { result ->
                                withContext(Dispatchers.IO) {
                                    CrmApi.setDisposition(requireNotNull(session.baseUrl), requireNotNull(session.token), result.callId, selected, notes.text.toString(), followUpAt)
                                    val schema = statusSchema
                                    if (record.id.isNotBlank() && schema != null && selectedStatus != null && selectedStatus != "Keep current status") {
                                        CrmApi.updateRecord(requireNotNull(session.baseUrl), requireNotNull(session.token), record, schema.fieldName, selectedStatus)
                                    }
                                }
                                dialog.dismiss(); toast("Saved to CRM")
                                if (powerMode && record.id.isNotBlank() && position < queue.lastIndex) { position++; showCurrent() }
                            }.onFailure { error ->
                                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                                toast(error.message ?: "Could not save the call result")
                            }
                        }
                    }
                }
            }.show()
    }

    private fun header(title: String, subtitle: String) {
        content.addView(TextView(this).apply { text = title; textSize = 28f; setTextColor(Color.rgb(70, 17, 120)); setTypeface(typeface, 1) })
        content.addView(note(subtitle)); content.addView(space(16))
    }
    private fun card(body: LinearLayout.() -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(16), dp(18), dp(16)); setBackgroundColor(Color.WHITE); elevation = dp(2).toFloat(); body(); content.addView(this); content.addView(space(12))
    }
    private fun input(hint: String, value: String, password: Boolean = false) = EditText(this).apply { this.hint = hint; setText(value); if (password) inputType = 0x81; setPadding(dp(12), dp(8), dp(12), dp(8)) }
    private fun label(text: String, size: Int = 17) = TextView(this).apply { this.text = text; textSize = size.toFloat(); setTextColor(Color.rgb(25, 25, 35)); setTypeface(typeface, 1); setPadding(0, dp(4), 0, dp(6)) }
    private fun note(text: String) = TextView(this).apply { this.text = text; textSize = 14f; setTextColor(Color.rgb(90, 90, 110)); setPadding(0, dp(2), 0, dp(8)) }
    private fun button(text: String, onClick: (View) -> Unit) = Button(this).apply { this.text = text; setOnClickListener(onClick); setTextColor(Color.WHITE); setBackgroundColor(Color.rgb(70, 17, 120)); isAllCaps = false; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(dp(3), dp(4), dp(3), dp(4)) } }
    private fun weighted() = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { setMargins(dp(3), dp(4), dp(3), dp(4)) }
    private fun space(height: Int) = Space(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(height)) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
