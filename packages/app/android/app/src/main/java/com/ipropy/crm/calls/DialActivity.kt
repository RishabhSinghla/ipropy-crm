package com.ipropy.crm.calls

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.telecom.TelecomManager
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast

/**
 * The number pad Android opens when something asks to dial — a contact's
 * "call" button, a tel: link — once iPropy is this phone's calling app.
 *
 * Android will not make an app the calling app unless it can do this, so it
 * is here, kept to one job: show the number, let it be corrected, and place
 * the call through Telecom — which hands it straight back to [LiveCall], so
 * the CRM sees it like any other.
 */
class DialActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val given = intent?.data?.schemeSpecificPart.orEmpty()

        val number = EditText(this).apply {
            setText(given)
            inputType = InputType.TYPE_CLASS_PHONE
            textSize = 26f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
        }
        val call = Button(this).apply {
            text = "Call"
            isAllCaps = false
            textSize = 18f
            setOnClickListener { place(number.text.toString()) }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0F172A"))
            setPadding(48, 48, 48, 48)
            addView(number)
            addView(call)
        })
    }

    private fun place(raw: String) {
        val number = raw.filter { it.isDigit() || it == '+' || it == '*' || it == '#' }
        if (number.isEmpty()) return
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CALL_PHONE), 1)
            return
        }
        try {
            (getSystemService(TELECOM_SERVICE) as TelecomManager).placeCall(Uri.fromParts("tel", number, null), Bundle())
            finish()
        } catch (e: SecurityException) {
            Toast.makeText(this, "Allow Phone for iPropy to place calls", Toast.LENGTH_LONG).show()
        }
    }
}
