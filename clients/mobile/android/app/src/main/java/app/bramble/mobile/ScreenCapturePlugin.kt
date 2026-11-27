package app.bramble.mobile

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Settings' "Block screenshots" switch and its 10-minute pause. MainActivity applies the stored
// setting at launch and on every resume, which also ends a pause that ran out while asleep.
@CapacitorPlugin(name = "ScreenCapture")
class ScreenCapturePlugin : Plugin() {
    @PluginMethod
    fun available(call: PluginCall) {
        call.resolve(JSObject().put("available", true))
    }

    @PluginMethod
    fun setBlocked(call: PluginCall) {
        val blocked = call.getBoolean("blocked") ?: return call.reject("blocked is required")
        activity.runOnUiThread {
            ScreenCapture.choose(blocked)
            ScreenCapture.apply(activity)
            call.resolve()
        }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val ms = call.data.optLong("ms", 0L).takeIf { it > 0 } ?: return call.reject("ms is required")
        activity.runOnUiThread {
            val until = ScreenCapture.pause(ms)
            ScreenCapture.apply(activity)
            call.resolve(JSObject().put("until", until))
        }
    }

    @PluginMethod
    fun pausedUntil(call: PluginCall) {
        call.resolve(JSObject().put("until", ScreenCapture.pausedUntil()))
    }
}
