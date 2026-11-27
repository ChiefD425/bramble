package app.bramble.mobile

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import java.lang.ref.WeakReference

// "Block screenshots": FLAG_SECURE keeps a window out of screenshots, recording, casting and an
// assistant's screenshot and view structure. See docs/screen-capture-blocking.md.
object ScreenCapture {
    private const val PREF = "meta:pref.screenCaptureBlocked"
    private const val FLAG = WindowManager.LayoutParams.FLAG_SECURE

    // This process only: the :autofill activities follow the stored setting, and MainActivity
    // ends a pause when it starts.
    @Volatile private var chosen: Boolean? = null
    @Volatile private var pauseEnds = 0L

    // The activity last applied to, so a pause running out reaches the window on screen now
    // rather than one recreated since.
    private var current = WeakReference<Activity>(null)
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val reapply = Runnable { current.get()?.let(::apply) }

    /** Only a stored `false` allows capture, so a missing or unreadable value blocks. */
    fun blockedBy(stored: String?): Boolean = stored?.trim() != "false"

    fun secure(blocked: Boolean, pausedUntil: Long, now: Long): Boolean = blocked && now >= pausedUntil

    private fun blocked(context: Context): Boolean = chosen ?: blockedBy(
        BrambleAutofill.appPrefs(context, BrambleAutofill.CAPACITOR_PREFS).getString(PREF, null),
    )

    /** Main thread only. Also ends a pause. */
    fun choose(blocked: Boolean) {
        chosen = blocked
        endPause()
    }

    /** Main thread only. */
    fun endPause() {
        pauseEnds = 0L
        main.removeCallbacks(reapply)
    }

    /** Main thread only. Allow capture for `ms`; returns when that ends, in wall-clock ms. */
    fun pause(ms: Long): Long {
        main.removeCallbacks(reapply)
        main.postDelayed(reapply, ms)
        return (System.currentTimeMillis() + ms).also { pauseEnds = it }
    }

    /** When the current pause ends, in wall-clock ms, or 0 when there is none. */
    fun pausedUntil(now: Long = System.currentTimeMillis()): Long = pauseEnds.takeIf { it > now } ?: 0L

    /** Main thread only. */
    fun apply(activity: Activity) {
        current = WeakReference(activity)
        if (secure(blocked(activity), pauseEnds, System.currentTimeMillis())) {
            activity.window.addFlags(FLAG)
        } else {
            activity.window.clearFlags(FLAG)
        }
    }
}
