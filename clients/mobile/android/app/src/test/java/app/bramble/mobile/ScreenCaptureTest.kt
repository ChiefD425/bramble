package app.bramble.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenCaptureTest {

    @Test
    fun onlyAStoredFalseAllowsCapture() {
        // Preferences holds the JSON the app wrote: "false", "true", or nothing yet.
        assertFalse(ScreenCapture.blockedBy("false"))
        assertFalse(ScreenCapture.blockedBy(" false\n"))
        assertTrue(ScreenCapture.blockedBy("true"))
        assertTrue(ScreenCapture.blockedBy(null))
        assertTrue(ScreenCapture.blockedBy(""))
        assertTrue(ScreenCapture.blockedBy("\"false\""))
    }

    @Test
    fun aPauseAllowsCaptureUntilItEnds() {
        assertFalse(ScreenCapture.secure(blocked = true, pausedUntil = 1_000L, now = 999L))
        assertTrue(ScreenCapture.secure(blocked = true, pausedUntil = 1_000L, now = 1_000L))
        assertTrue(ScreenCapture.secure(blocked = true, pausedUntil = 0L, now = 5L))
        assertFalse(ScreenCapture.secure(blocked = false, pausedUntil = 0L, now = 5L))
    }
}
