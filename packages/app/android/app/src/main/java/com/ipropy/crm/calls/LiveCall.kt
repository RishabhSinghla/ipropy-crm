package com.ipropy.crm.calls

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.VideoProfile
import android.util.Log
import com.ipropy.crm.callsync.Api
import com.ipropy.crm.callsync.Prefs
import org.json.JSONObject

/**
 * The call this phone is on, and the one place anything is done to it.
 *
 * **Why this exists.** Android lets only the phone's *calling app* touch a
 * call that is already running — switch the speaker, mute, hold, or know the
 * moment the other side picks up. So when the rep makes iPropy their calling
 * app, [PhoneCallService] hands every call here, and three things follow:
 *
 *  1. Every change — ringing, answered, on hold, speaker, mute, ended — is
 *     reported to the CRM, which shows it on the call deck on the desk.
 *  2. The desk's buttons arrive as instructions, collected every second while
 *     a call is up, and are carried out here.
 *  3. The in-call screen on the phone ([InCallActivity]) uses the very same
 *     functions, so a tap on the phone and a click on the desk cannot behave
 *     differently.
 *
 * One object rather than state spread across the service, the screen and the
 * plugin, because they each come and go on their own schedule (the screen is
 * closed, the web view is asleep) and the call must not care.
 */
object LiveCall {
    private const val TAG = "iPropyLiveCall"
    private const val POLL_EVERY_MS = 1_000L

    /** Every call Telecom has handed us, newest last. Usually one. */
    private val calls = mutableListOf<Call>()
    private var service: PhoneCallService? = null
    private var appContext: Context? = null
    private var audio: CallAudioState? = null
    /** When the current call was answered, on this phone's clock. */
    var connectedAt: Long? = null
        private set

    private val listeners = mutableSetOf<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val network: Handler by lazy {
        Handler(HandlerThread("ipropy-live-call").apply { start() }.looper)
    }
    private var polling = false

    /** The call a person means by "the call" — the newest one not yet over. */
    val current: Call?
        get() = calls.lastOrNull { stateOf(it) != Call.STATE_DISCONNECTED } ?: calls.lastOrNull()

    val speakerOn: Boolean
        get() = audio?.route == CallAudioState.ROUTE_SPEAKER
    val muted: Boolean
        get() = audio?.isMuted == true

    fun addListener(listener: () -> Unit) { listeners.add(listener) }
    fun removeListener(listener: () -> Unit) { listeners.remove(listener) }

    // -----------------------------------------------------------------------
    // Telecom's side: calls arriving, changing and leaving
    // -----------------------------------------------------------------------

    fun attach(owner: PhoneCallService, call: Call) {
        service = owner
        appContext = owner.applicationContext
        calls.add(call)
        if (calls.size == 1) connectedAt = null
        call.registerCallback(callback)
        if (stateOf(call) == Call.STATE_ACTIVE && connectedAt == null) connectedAt = System.currentTimeMillis()
        changed()
        startPolling()
    }

    fun detach(call: Call) {
        call.unregisterCallback(callback)
        calls.remove(call)
        changed()
        if (calls.isEmpty()) {
            service = null
            connectedAt = null
        }
    }

    fun audioChanged(state: CallAudioState?) {
        audio = state
        changed()
    }

    private val callback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            if (state == Call.STATE_ACTIVE && connectedAt == null) connectedAt = System.currentTimeMillis()
            changed()
        }
    }

    // -----------------------------------------------------------------------
    // The controls — one definition, used by the phone's screen and the desk
    // -----------------------------------------------------------------------

    /** Carry out one instruction. Answers null when done, or why it was not. */
    fun perform(action: String, on: Boolean): String? {
        val call = current ?: return "no-call"
        val owner = service ?: return "no-call"
        return try {
            when (action) {
                "speaker" -> {
                    @Suppress("DEPRECATION")
                    owner.setAudioRoute(if (on) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_WIRED_OR_EARPIECE)
                    null
                }
                "mute" -> { owner.setMuted(on); null }
                "hold" -> {
                    if (on) call.hold() else call.unhold()
                    null
                }
                "end" -> { end(); null }
                "answer" -> { call.answer(VideoProfile.STATE_AUDIO_ONLY); null }
                else -> "unknown-action"
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not $action", e)
            e.message ?: "failed"
        }
    }

    /** Hang up, or turn down a call still ringing in. */
    fun end() {
        val call = current ?: return
        if (stateOf(call) == Call.STATE_RINGING) call.reject(false, null) else call.disconnect()
    }

    // -----------------------------------------------------------------------
    // Telling the CRM, and listening to it
    // -----------------------------------------------------------------------

    /** The word the CRM uses for a Telecom state. */
    fun stateWord(call: Call?): String? = when (call?.let { stateOf(it) }) {
        null -> null
        Call.STATE_RINGING -> "ringing"
        Call.STATE_ACTIVE -> "active"
        Call.STATE_HOLDING -> "held"
        Call.STATE_DISCONNECTED, Call.STATE_DISCONNECTING -> "ended"
        else -> "dialling"
    }

    fun numberOf(call: Call?): String? = call?.details?.handle?.schemeSpecificPart

    fun isIncoming(call: Call?): Boolean {
        if (call == null) return false
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            return call.details.callDirection == Call.Details.DIRECTION_INCOMING
        }
        return stateOf(call) == Call.STATE_RINGING
    }

    @Suppress("DEPRECATION")
    fun stateOf(call: Call): Int = call.state

    private fun changed() {
        main.post { listeners.toList().forEach { runCatching { it() } } }
        report()
    }

    private fun report() {
        val context = appContext ?: return
        val call = current
        val body = JSONObject()
            .put("canEndCall", true)
            .put("canControlCall", true)
            .put("liveState", stateWord(call) ?: "ended")
            .put("liveNumber", numberOf(call) ?: JSONObject.NULL)
            .put("direction", if (isIncoming(call)) "incoming" else "outgoing")
            .put("speaker", speakerOn)
            .put("muted", muted)
        network.post {
            val prefs = Prefs(context)
            val base = prefs.baseUrl ?: return@post
            val token = runCatching { prefs.token }.getOrNull() ?: return@post
            Api.reportCallState(base, token, body)
        }
    }

    /**
     * Collect the desk's instructions every second while a call is up.
     *
     * Natively, with the device token, rather than through the app's web view:
     * a rep on a call has the phone at their ear and the app closed, and the
     * web view is exactly what Android puts to sleep first.
     */
    private fun startPolling() {
        if (polling) return
        polling = true
        network.post(object : Runnable {
            override fun run() {
                val context = appContext
                if (calls.isEmpty() || context == null) { polling = false; return }
                val prefs = Prefs(context)
                val base = prefs.baseUrl
                val token = runCatching { prefs.token }.getOrNull()
                if (base != null && token != null) {
                    Api.nextCommand(base, token)?.let { command -> carryOut(base, token, command) }
                }
                network.postDelayed(this, POLL_EVERY_MS)
            }
        })
    }

    private fun carryOut(base: String, token: String, command: JSONObject) {
        val id = command.optString("id")
        val kind = command.optString("kind")
        val payload = command.optJSONObject("payload") ?: JSONObject()
        val action = when (kind) {
            "hangup" -> "end"
            "control" -> payload.optString("action")
            else -> null
        }
        if (action == null) {
            // A dial is the web view's to place; give it back as not handled here.
            Api.reportCommand(base, token, id, false, "not-a-live-call-command")
            return
        }
        val on = payload.optBoolean("on", true)
        main.post {
            val error = perform(action, on)
            network.post { Api.reportCommand(base, token, id, error == null, error) }
        }
    }
}
