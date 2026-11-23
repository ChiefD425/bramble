package app.bramble.mobile

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import androidx.annotation.RequiresApi

// The fill of a login with an authenticator key, while "Copy 2FA codes when filling" is on (#99).
// Android fills a suggestion without telling the service which one was chosen, except through
// the suggestion's authentication; this is that step. It has no UI: it reads the login through
// the keep-unlocked session the suggestion came from, copies the code, and hands back the fill.
// Only the login's id travels in the intent, never its secrets.
@RequiresApi(Build.VERSION_CODES.O)
class TotpCopyActivity : Activity() {
    companion object {
        const val EXTRA_LOGIN_ID = "app.bramble.autofill.LOGIN_ID"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        try {
            fill()
        } catch (e: Exception) {
            Log.e(BrambleAutofill.LOG_TAG, "2FA copy fill failed", e)
        }
        finish()
    }

    private fun fill() {
        val id = intent.getStringExtra(EXTRA_LOGIN_ID) ?: return
        // Expired since the suggestion was shown: fill nothing, and the next tap asks to unlock.
        val vek = KeepUnlockedStore.load(this) ?: return
        val login = CoreSession.borrow(vek) { VaultReader.readLogins(this) }.firstOrNull { it.id == id } ?: return
        val now = System.currentTimeMillis()
        val dataset = Datasets.fillDataset(
            this, login,
            ids(AutofillUnlockActivity.EXTRA_USERNAME_IDS),
            ids(AutofillUnlockActivity.EXTRA_PASSWORD_IDS),
            ids(AutofillUnlockActivity.EXTRA_OTP_IDS),
            now,
        ) ?: return
        Totp.generate(login.totp, now)?.let { TotpCopy.copy(this, it) }
        setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
    }

    @Suppress("DEPRECATION")
    private fun ids(key: String): List<AutofillId> = intent.getParcelableArrayListExtra(key) ?: emptyList()
}
