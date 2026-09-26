package com.ipropy.crm.calls

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService
import androidx.core.app.NotificationCompat
import com.ipropy.crm.R

/**
 * Android's hand-over of every call on this phone, once iPropy is its
 * calling app.
 *
 * Kept thin on purpose: it passes calls to [LiveCall], which does everything,
 * and it puts the in-call screen in front of the rep — straight away for a
 * call they placed, and through a full-screen notification for one ringing
 * in, which is how Android lets a calling app take over a locked screen.
 *
 * Ringing itself is left to Android (`IN_CALL_SERVICE_RINGING` is false in the
 * manifest), so the rep's own ringtone and vibration stay exactly as they
 * set them.
 */
class PhoneCallService : InCallService() {

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        LiveCall.attach(this, call)
        if (LiveCall.stateOf(call) == Call.STATE_RINGING) {
            showIncoming(call)
        } else {
            startActivity(InCallActivity.intent(this))
        }
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        LiveCall.detach(call)
        if (LiveCall.current == null) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onCallAudioStateChanged(audioState: CallAudioState?) {
        @Suppress("DEPRECATION")
        super.onCallAudioStateChanged(audioState)
        LiveCall.audioChanged(audioState)
    }

    private fun showIncoming(call: Call) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                    // Android rings; the notification only carries the screen.
                    setSound(null, null)
                },
            )
        }
        val screen = PendingIntent.getActivity(
            this, 0, InCallActivity.intent(this),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Incoming call")
            .setContentText(LiveCall.numberOf(call) ?: "Unknown number")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setContentIntent(screen)
            .setFullScreenIntent(screen, true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    companion object {
        private const val CHANNEL_ID = "ipropy-incoming-calls"
        private const val NOTIFICATION_ID = 7310
    }
}
