package app.bramble.mobile

import android.content.Context
import org.json.JSONObject

// A login made with "New login" in the autofill picker, VEK-encrypted for the app to save; the
// provider never writes the vault. Its password is already on the sign-up form, so the app only
// removes a record once the login is in the vault, and the picker offers it until then
// (VaultReader.readLogins). The caller MUST have the VEK loaded. See EncryptedHandoff.
object PendingLogin {
    const val FILE = "autofill_pending_logins.json"

    fun write(context: Context, name: String, url: String, username: String, password: String) {
        val json = JSONObject()
            .put("name", name)
            .put("url", url)
            .put("username", username)
            .put("password", password)
        EncryptedHandoff.append(context, FILE, json.toString())
    }
}

/** The vault's logins plus the picker's own not yet saved, minus any the app has saved since. */
internal fun withPending(logins: List<AutofillLogin>, pending: List<AutofillLogin>): List<AutofillLogin> {
    val out = logins.toMutableList()
    for (p in pending) {
        if (out.none { it.password == p.password && it.username == p.username }) out.add(p)
    }
    return out
}
