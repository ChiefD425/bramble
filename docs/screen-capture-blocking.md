# Blocking screenshots

Bramble keeps its windows out of screenshots, screen recording, screen sharing and assistants that
read the screen (Gemini, Circle to Search, Apple Intelligence, Windows Recall). It is on by default
wherever the OS offers a way to do it. Settings → General → "Block screenshots" turns it off, or
"Allow for 10 minutes" lets one screenshot through, such as of a recovery code. Code:
`packages/core/src/app/screen-capture.ts`, `Settings/components/ScreenCaptureRow.tsx`, and one
native piece per platform, listed below.

## Why on by default

Issue #148 hid the vault from the app switcher only, and kept screenshots working on purpose so a
recovery code or a QR code could be saved. That changed once phones gained assistants that read
whatever is on screen: Gemini and Circle to Search take the screen when asked, and Android cannot
tell Bramble about every assistant. Signal now blocks capture by default on iOS, and asks on Android
when it sees an assistant through the assist API, which misses assistants that don't use it. A
password manager is rarely the app anyone needs a screenshot of, so Bramble blocks by default on
every platform and keeps the escape hatch one tap away. The 10-minute pause ends on its own, and it
lives only in memory: quitting Bramble blocks again.

## The setting

- `pref.screenCaptureBlocked`, device-scoped, default `true`. Only a stored `false` turns blocking
  off, so a missing or unreadable value blocks. Native code reads it at launch, before the webview
  has run, so the first frame is already protected.
- The shell's `screenCapture` (`ShellAdapter`) applies a change now. Persisting it is the caller's
  job, as with the passkey provider switch.
- `screenCapture.pause(ms)` allows capture until a deadline the native side keeps, and returns it.
  The native side blocks again at the deadline, and also on every return to the foreground once it
  has passed, so a sleeping device or a throttled webview timer cannot stretch the pause.
- `screenCapture.pausedUntil()` reads that deadline back, so the row still shows a pause after a
  reload of the page has emptied the webview's copy.
- The row renders itself away where `screenCapture` is absent or `available()` says no.

## Platforms

| Platform  | How                                                                    | What it stops |
|-----------|------------------------------------------------------------------------|---------------|
| Android   | `FLAG_SECURE` on `MainActivity` and the AutoFill unlock and passkey activities (`ScreenCapture.kt`) | Screenshots, recording, casting, the Recents card, and the assistant's screenshot and view structure |
| iOS       | The capture-redaction flag on the app window's layer (`ScreenCapture.swift`) | Screenshots, recording, mirroring and the app switcher snapshot |
| Windows   | Tauri `contentProtected` (`WDA_EXCLUDEFROMCAPTURE`) on both windows    | Screenshots, screen sharing, Recall |
| macOS     | Tauri `contentProtected` (`NSWindowSharingNone`) on both windows       | Older capture paths only, see below |
| Linux     | Nothing exists                                                         | Nothing; the row is hidden |
| Extension | A browser extension can't control OS capture                           | Nothing; the row is hidden |

### Android

`FLAG_SECURE` blanks the window in screenshots and recordings, and Android's assist framework sends
an assistant neither the screenshot nor the view structure of a secure window. The Recents card is
blank too, so the #148 handling (`setRecentsScreenshotEnabled(false)` on 13+, `FLAG_SECURE` while
paused below 13) only matters when blocking is off. The AutoFill picker and passkey activities run
in the `:autofill` process, which has no pause: they follow the stored setting. With the flag set,
Android tells the user itself that the app doesn't allow screenshots.

The pause and its timer live in `ScreenCapture`, not the plugin: an activity recreated mid-pause (a
font size change) gets a new plugin, and the timer applies to whichever activity it last touched. A
new `MainActivity` ends any pause, so swiping Bramble away ends it even when a foreground service
keeps the process alive.

### iOS

iOS has no public API for this. The render server leaves a layer out of screenshots, recordings and
mirroring when the layer's private `disableUpdateMask` holds the bits UIKit gives the text of a
secure `UITextField`. On first use Bramble makes a secure text field, reads the first nonzero mask in
its layer tree, and from then on sets or clears just those bits on the app window's layer.

- The bits come from UIKit on the running iOS rather than a constant. If `CALayer` has no
  `setDisableUpdateMask:`, a secure field carries no mask, or the bits don't land on and lift off a
  spare layer, `available()` says false, which hides the setting rather than offering one that does
  nothing.
- Nothing is swapped: no view's layer changes hands, and the property is checked for before it is
  touched, so a UIKit change can't crash launch.
- On the iOS 18.4 and 26.4 simulators the bits are 0x12, the app draws normally, and the app
  switcher snapshot (a render server capture) is black with blocking on and the #148 cover with it
  off. Signal enables its blocking on iOS 27 only; Bramble enables it wherever the check passes. A
  screenshot on a real device is still to be confirmed.
- iOS tells nobody when a screenshot is blank, so after one is taken while blocking is on, Bramble
  shows a toast with "Allow for 10 minutes".
- The #148 cover over the app switcher stays: it also covers versions where the check fails.

### macOS

`NSWindowSharingNone` keeps the window out of `CGWindowListCreateImage` and older capture paths, but
developers report ScreenCaptureKit ignores it from macOS 15.4, and most current screenshot,
recording and sharing tools use ScreenCaptureKit. Bramble still sets it, since it costs nothing and
stops what still honors it, and says so in the row's subtitle. On macOS 27 the user can also keep
Apple Intelligence from reading Bramble in System Settings → Siri → Excluded Apps, which the help
article covers.

### Windows

`WDA_EXCLUDEFROMCAPTURE` (Windows 10 2004 and later) removes the window from every capture,
including Recall's snapshots and screen sharing, which show it as missing. Not yet checked: whether
Magnifier's lens and docked views show an excluded window. The help article tells anyone who sees
Bramble blank in a magnifier to turn the setting off.

Both desktop windows start protected (`contentProtected` in `tauri.conf.json`), and setup lifts it
if the stored setting says so. The main window, rebuilt after a close on Wayland, takes the current
state again.

## Not covered

- The iOS AutoFill extension's picker. It runs in its own process with its own window; it would need
  the setting from the App Group and the same mask on its own window.
- Linux and the browser extension, which have no mechanism.
