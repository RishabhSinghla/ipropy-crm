package com.ipropy.crm.calls

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.Call
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The phone's own in-call screen, once iPropy is its calling app.
 *
 * Android shows a calling app's screen instead of its own, so this has to do
 * what the stock one did: who it is, ringing or the clock, speaker, mute,
 * hold and the red button — and, for a call ringing in, answer and decline.
 *
 * Built in code rather than from a layout file on purpose: it is one screen
 * of fixed controls, and every button calls [LiveCall] — the same functions
 * the desk's buttons reach — so a tap here and a click on the CRM cannot do
 * different things. The clock starts when the other side picks up, never when
 * the number is dialled.
 */
class InCallActivity : Activity() {

    private lateinit var who: TextView
    private lateinit var status: TextView
    private lateinit var controls: LinearLayout
    private lateinit var incoming: LinearLayout
    private lateinit var speaker: Button
    private lateinit var mute: Button
    private lateinit var hold: Button
    private val ticker = Handler(Looper.getMainLooper())
    private val refresh: () -> Unit = { draw() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Over the lock screen, and waking it, the way a phone call does.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        setContentView(build())
    }

    override fun onStart() {
        super.onStart()
        LiveCall.addListener(refresh)
        tick()
        draw()
    }

    override fun onStop() {
        LiveCall.removeListener(refresh)
        ticker.removeCallbacksAndMessages(null)
        super.onStop()
    }

    private fun tick() {
        ticker.postDelayed({ draw(); tick() }, 1_000)
    }

    private fun draw() {
        val call = LiveCall.current
        if (call == null) { finish(); return }
        who.text = LiveCall.numberOf(call) ?: "Unknown number"
        val state = LiveCall.stateOf(call)
        val ringingIn = state == Call.STATE_RINGING
        incoming.visibility = if (ringingIn) LinearLayout.VISIBLE else LinearLayout.GONE
        controls.visibility = if (ringingIn) LinearLayout.GONE else LinearLayout.VISIBLE
        status.text = when (state) {
            Call.STATE_RINGING -> "Incoming call"
            Call.STATE_ACTIVE -> clock()
            Call.STATE_HOLDING -> "On hold · ${clock()}"
            Call.STATE_DISCONNECTED, Call.STATE_DISCONNECTING -> "Call ended"
            else -> "Ringing…"
        }
        paint(speaker, LiveCall.speakerOn)
        paint(mute, LiveCall.muted)
        paint(hold, state == Call.STATE_HOLDING)
        val live = state == Call.STATE_ACTIVE || state == Call.STATE_HOLDING
        hold.isEnabled = live
        hold.alpha = if (live) 1f else 0.4f
    }

    private fun clock(): String {
        val since = LiveCall.connectedAt ?: return "Connecting…"
        val seconds = (System.currentTimeMillis() - since) / 1000
        return "%d:%02d".format(seconds / 60, seconds % 60)
    }

    private fun build(): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(Color.parseColor("#0F172A"))
            setPadding(dp(24), dp(96), dp(24), dp(48))
        }
        who = TextView(this).apply {
            setTextColor(Color.WHITE); textSize = 28f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
        }
        status = TextView(this).apply {
            setTextColor(Color.parseColor("#94A3B8")); textSize = 18f; gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(64))
        }
        root.addView(who)
        root.addView(status)

        speaker = toggle("Speaker") { LiveCall.perform("speaker", !LiveCall.speakerOn) }
        mute = toggle("Mute") { LiveCall.perform("mute", !LiveCall.muted) }
        hold = toggle("Hold") {
            val call = LiveCall.current
            LiveCall.perform("hold", call != null && LiveCall.stateOf(call) != Call.STATE_HOLDING)
        }
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        listOf(speaker, mute, hold).forEach { row.addView(it, square()) }
        controls = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        controls.addView(row)
        controls.addView(round("End", "#EF4444") { LiveCall.end() }, bigRound())
        root.addView(controls)

        incoming = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        incoming.addView(round("Decline", "#EF4444") { LiveCall.end() }, bigRound())
        incoming.addView(round("Answer", "#10B981") { LiveCall.perform("answer", true) }, bigRound())
        root.addView(incoming)
        return root
    }

    private fun toggle(label: String, onTap: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        setOnClickListener { onTap(); draw() }
    }

    private fun round(label: String, colour: String, onTap: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        textSize = 16f
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.parseColor(colour)) }
        setOnClickListener { onTap() }
    }

    /** Highlighted when that switch is on, so the phone and the desk read the same. */
    private fun paint(button: Button, on: Boolean) {
        button.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor(if (on) "#2563EB" else "#334155"))
        }
    }

    private fun square(): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(dp(84), dp(84)).apply { setMargins(dp(10), dp(10), dp(10), dp(10)) }

    private fun bigRound(): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(dp(88), dp(88)).apply { setMargins(dp(24), dp(40), dp(24), 0) }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        fun intent(context: Context): Intent = Intent(context, InCallActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}
