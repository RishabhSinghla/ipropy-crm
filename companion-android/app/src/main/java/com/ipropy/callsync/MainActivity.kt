package com.ipropy.callsync

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The only screen.
 *
 * Pair once, grant permissions, and then this app is meant to be forgotten —
 * the sync runs in the background and the CRM is where anyone actually looks.
 * So this screen optimises for the two things a person ever comes back for:
 * checking that it is still working, and turning it off.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var statusView: TextView
    private lateinit var urlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var recordingsToggle: CheckBox
    private lateinit var historyToggle: CheckBox
    private lateinit var recordingFolderView: TextView

    private val folderLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        if (uri != null) {
            try {
                contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
                prefs.recordingTreeUri = uri.toString()
                prefs.uploadRecordings = true
                recordingsToggle.isChecked = true
            } catch (_: SecurityException) {
                prefs.uploadRecordings = false
                recordingsToggle.isChecked = false
                toast(getString(R.string.folder_permission_failed))
            }
        } else if (prefs.recordingTreeUri.isNullOrBlank()) {
            prefs.uploadRecordings = false
            recordingsToggle.isChecked = false
        }
        renderRecordingFolder()
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { _ ->
        // READ_CALL_LOG may already be granted while Android asks only for the
        // notification permission, in which case it is absent from the result
        // map. Check the actual permission state instead of the returned subset.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG)
            == PackageManager.PERMISSION_GRANTED
        ) {
            onCallLogPermissionReady()
        } else {
            // Said plainly rather than as a generic denial: without this one
            // permission the app has nothing at all to do.
            statusView.text = getString(R.string.needs_call_log)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = Prefs(this)
        statusView = findViewById(R.id.status)
        urlInput = findViewById(R.id.url_input)
        tokenInput = findViewById(R.id.token_input)
        recordingsToggle = findViewById(R.id.recordings_toggle)
        historyToggle = findViewById(R.id.history_toggle)
        recordingFolderView = findViewById(R.id.recording_folder_status)

        urlInput.setText(prefs.baseUrl ?: "")
        recordingsToggle.isChecked = prefs.uploadRecordings
        historyToggle.isChecked = prefs.importExistingHistory

        findViewById<Button>(R.id.pair_button).setOnClickListener { pair() }
        findViewById<Button>(R.id.sync_button).setOnClickListener { syncNow() }
        findViewById<Button>(R.id.unpair_button).setOnClickListener { unpair() }
        findViewById<Button>(R.id.recording_folder_button).setOnClickListener { chooseRecordingFolder() }

        historyToggle.setOnCheckedChangeListener { _, checked ->
            prefs.importExistingHistory = checked
        }

        recordingsToggle.setOnCheckedChangeListener { _, checked ->
            prefs.uploadRecordings = checked
            if (checked && prefs.recordingTreeUri.isNullOrBlank()) chooseRecordingFolder()
        }

        render()
        renderRecordingFolder()
        if (prefs.isPaired) requestPermissions()
    }

    private fun pair() {
        val url = urlInput.text.toString().trim().trimEnd('/')
        val token = tokenInput.text.toString().trim()

        if (url.isBlank() || token.isBlank()) {
            toast(getString(R.string.enter_both))
            return
        }
        val parsed = runCatching { Uri.parse(url) }.getOrNull()
        if (parsed?.scheme != "https" || parsed.host.isNullOrBlank()) {
            toast(getString(R.string.url_needs_scheme))
            return
        }
        if (!prefs.secureStorageAvailable) {
            statusView.text = getString(R.string.secure_storage_unavailable)
            return
        }

        statusView.text = getString(R.string.checking)
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { Api.ping(url, token) }
            if (ok) {
                prefs.baseUrl = url
                prefs.token = token
                tokenInput.setText("")
                toast(getString(R.string.paired))
                requestPermissions()
            } else {
                statusView.text = getString(R.string.pairing_failed)
            }
            render()
        }
    }

    private fun unpair() {
        SyncWorker.cancel(this)
        prefs.recordingTreeUri?.let { value ->
            runCatching {
                contentResolver.releasePersistableUriPermission(
                    Uri.parse(value),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
        }
        prefs.clear()
        urlInput.setText("")
        recordingsToggle.isChecked = false
        historyToggle.isChecked = false
        toast(getString(R.string.unpaired))
        render()
        renderRecordingFolder()
    }

    private fun syncNow() {
        if (!prefs.isPaired) {
            toast(getString(R.string.pair_first))
            return
        }
        statusView.text = getString(R.string.syncing)
        lifecycleScope.launch {
            withContext(Dispatchers.IO) {
                val baseUrl = prefs.baseUrl ?: return@withContext
                val token = prefs.token ?: return@withContext
                val batch = CallLogReader.read(applicationContext, prefs.lastCallId, 400)
                if (batch.failed) {
                    prefs.lastSyncSummary = getString(R.string.needs_call_log)
                    return@withContext
                }
                val result = Api.syncCalls(baseUrl, token, batch.entries, BuildConfigCompat.versionName)
                if (result != null) {
                    prefs.lastCallId = batch.lastSeenId.coerceAtLeast(prefs.lastCallId)
                    prefs.lastSyncAt = System.currentTimeMillis()
                    prefs.lastSyncSummary = "Synced ${result.created} new, ${result.matched} matched to leads"
                } else {
                    prefs.lastSyncSummary = "Could not reach the CRM"
                }

                // Ask what the CRM wants, here as well as in the worker.
                //
                // Without this a phone paired five minutes ago has never heard
                // the answer — the worker's first run may be a quarter of an
                // hour away — so the cached answer is still the safe default of
                // off, and the rep is never asked for the permission that makes
                // the whole thing work. They would put the phone in their
                // pocket believing they were set up.
                Api.fetchPolicy(baseUrl, token)?.let { policy ->
                    prefs.locationEnabled = policy.enabled
                    prefs.locationEveryMinutes = policy.everyMinutes
                }
            }
            render()
            if (prefs.locationEnabled) askForBackgroundLocation()
        }
    }

    /** Reset by the OS killing the activity, which is the right cadence to re-ask. */
    private var askedForBackgroundLocation = false

    private fun requestPermissions() {
        val wanted = mutableListOf(Manifest.permission.READ_CALL_LOG)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        // Foreground location in the same dialog. Background is a separate act
        // and cannot be asked for here — see `askForBackgroundLocation`.
        wanted.add(Manifest.permission.ACCESS_COARSE_LOCATION)
        wanted.add(Manifest.permission.ACCESS_FINE_LOCATION)

        val missing = wanted.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            onCallLogPermissionReady()
        } else {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    /**
     * The second half of location, which Android will not let an app ask for.
     *
     * From Android 10, "Allow all the time" is not available in any dialog an
     * app can raise. The person has to open the app's own settings page and
     * choose it there, and an app that requests it programmatically is refused
     * without a prompt appearing at all — so a rep would grant location, see
     * nothing wrong, and report nothing while the CRM showed them as offline.
     *
     * So this says what is needed in words and opens the right page. It is
     * offered rather than forced: without it the app still reports a position
     * whenever somebody opens it, which is worth having.
     */
    private fun askForBackgroundLocation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        if (LocationSampler.hasBackgroundPermission(this)) return
        if (!LocationSampler.hasForegroundPermission(this)) return
        // Once per launch. Somebody who taps "Not now" has answered; asking
        // again after every sync would make the app something they close.
        if (askedForBackgroundLocation) return
        askedForBackgroundLocation = true

        AlertDialog.Builder(this)
            .setTitle(R.string.background_location_title)
            .setMessage(R.string.background_location_body)
            .setPositiveButton(R.string.open_settings) { _, _ ->
                startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", packageName, null),
                    ),
                )
            }
            .setNegativeButton(R.string.not_now, null)
            .show()
    }

    private fun onCallLogPermissionReady() {
        if (!prefs.watermarkInitialised) {
            if (!prefs.importExistingHistory) {
                prefs.lastCallId = CallLogReader.currentHighestId(this)
            }
            prefs.watermarkInitialised = true
        }
        SyncWorker.schedule(this)
        // `syncNow` asks the CRM whether positions are wanted and raises the
        // background-location prompt itself once it knows. Asking here would
        // be asking before the answer had arrived.
        syncNow()
    }

    private fun chooseRecordingFolder() {
        folderLauncher.launch(prefs.recordingTreeUri?.let(Uri::parse))
    }

    private fun renderRecordingFolder() {
        recordingFolderView.text = if (prefs.recordingTreeUri.isNullOrBlank()) {
            getString(R.string.no_recording_folder)
        } else {
            getString(R.string.recording_folder_selected)
        }
    }

    private fun render() {
        val paired = prefs.isPaired
        findViewById<Button>(R.id.pair_button).text =
            getString(if (paired) R.string.re_pair else R.string.pair)
        findViewById<Button>(R.id.unpair_button).isEnabled = paired
        historyToggle.isEnabled = !prefs.watermarkInitialised

        statusView.text = when {
            !paired -> getString(R.string.not_paired)
            prefs.lastSyncAt == 0L -> getString(R.string.paired_no_sync)
            else -> {
                val when_ = SimpleDateFormat("d MMM, h:mm a", Locale.getDefault())
                    .format(Date(prefs.lastSyncAt))
                "${prefs.lastSyncSummary ?: getString(R.string.synced)}\n${getString(R.string.last_sync)} $when_"
            }
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}
