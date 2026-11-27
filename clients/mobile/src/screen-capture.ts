import { registerPlugin } from "@capacitor/core";
import type { ScreenCaptureControl } from "@core/index";

// FLAG_SECURE on Android (ScreenCapturePlugin.kt), the window layer's capture redaction on iOS
// (ScreenCapture.swift). Both read pref.screenCaptureBlocked at launch themselves.
interface ScreenCapturePlugin {
	available(): Promise<{ available: boolean }>;
	setBlocked(options: { blocked: boolean }): Promise<void>;
	pause(options: { ms: number }): Promise<{ until: number }>;
	pausedUntil(): Promise<{ until: number }>;
	addListener(event: "blockedScreenshot", cb: () => void): Promise<{ remove: () => Promise<void> }>;
}

const Native = registerPlugin<ScreenCapturePlugin>("ScreenCapture");

export const screenCapture: ScreenCaptureControl = {
	// A build without the plugin (the web preview) rejects, which reads as "can't block here".
	available: () =>
		Native.available().then(
			(r) => r.available,
			() => false,
		),
	setBlocked: (blocked) => Native.setBlocked({ blocked }),
	pause: (ms) => Native.pause({ ms }).then((r) => r.until),
	pausedUntil: () => Native.pausedUntil().then((r) => r.until),
	onBlockedScreenshot(cb) {
		const sub = Native.addListener("blockedScreenshot", cb);
		return () => {
			void sub.then((h) => h.remove());
		};
	},
};
