package app.bramble.mobile

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// The app's side of the provider handoffs (EncryptedHandoff): the same drain methods as the iOS
// AutofillBridge, so encrypted-handoff.ts drives both platforms alike. Draining here rather than
// through the Filesystem plugin puts it under the provider's own lock. Besides `lock`, Android has
// no other AutofillBridge methods: its providers read the vault file directly.
@CapacitorPlugin(name = "AutofillBridge")
class AutofillBridgePlugin : Plugin() {
    @PluginMethod
    fun consumePendingPasskeys(call: PluginCall) = consume(call, PendingPasskey.FILE)

    @PluginMethod
    fun restorePendingPasskeys(call: PluginCall) = restore(call, PendingPasskey.FILE)

    @PluginMethod
    fun consumePendingAssociations(call: PluginCall) = consume(call, PendingAssociation.FILE)

    @PluginMethod
    fun restorePendingAssociations(call: PluginCall) = restore(call, PendingAssociation.FILE)

    // New logins stay queued until the app has saved them, so these read and remove rather than drain.
    @PluginMethod
    fun peekPendingLogins(call: PluginCall) {
        try {
            val pending = EncryptedHandoff.peek(context, PendingLogin.FILE)
            call.resolve(JSObject().put("pending", JSArray(pending.toString())))
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    @PluginMethod
    fun removePendingLogins(call: PluginCall) {
        try {
            val ivs = call.getArray("ivs")?.toList<String>()?.toSet() ?: emptySet()
            EncryptedHandoff.remove(context, PendingLogin.FILE, ivs)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    @PluginMethod
    fun lock(call: PluginCall) {
        try {
            KeepUnlockedStore.lock()
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    private fun consume(call: PluginCall, name: String) {
        try {
            val pending = EncryptedHandoff.take(context, name)
            call.resolve(JSObject().put("pending", JSArray(pending.toString())))
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    private fun restore(call: PluginCall, name: String) {
        try {
            EncryptedHandoff.restore(context, name, call.getArray("keep") ?: JSArray())
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }
}
