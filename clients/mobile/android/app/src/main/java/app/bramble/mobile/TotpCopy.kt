package app.bramble.mobile

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.util.Log

// "Copy 2FA codes when filling" (#99): filling a login that has an authenticator key puts its
// current code on the clipboard, ready to paste on the page that asks for it next.
object TotpCopy {
    private const val LABEL = "Bramble 2FA code"
    private const val DEFAULT_CLEAR_SECONDS = 30

    /** Off unless the user turned it on: it puts a secret on the clipboard. */
    fun enabled(context: Context): Boolean =
        BrambleAutofill.appPrefs(context, BrambleAutofill.CAPACITOR_PREFS)
            .getString(BrambleAutofill.PREF_COPY_TOTP_ON_FILL, null)?.trim() == "true"

    /** Copy `code`, marked sensitive so the system's clipboard preview hides it, and clear it after
     * the clipboard auto-clear time. The clear is best effort, as the app's own copies are: it
     * runs in this process, which Android may end first. */
    fun copy(context: Context, code: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
        val clip = ClipData.newPlainText(LABEL, code)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras =
                PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        }
        try {
            clipboard.setPrimaryClip(clip)
        } catch (e: Exception) {
            Log.w(BrambleAutofill.LOG_TAG, "2FA code not copied", e)
            return
        }
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    clipboard.clearPrimaryClip()
                } else {
                    clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            } catch (_: Exception) {}
        }, clearSeconds(context) * 1000L)
    }

    private fun clearSeconds(context: Context): Int =
        BrambleAutofill.appPrefs(context, BrambleAutofill.CAPACITOR_PREFS)
            .getString(BrambleAutofill.PREF_CLIPBOARD_SECONDS, null)?.trim()?.toIntOrNull()
            ?.takeIf { it > 0 } ?: DEFAULT_CLEAR_SECONDS
}
