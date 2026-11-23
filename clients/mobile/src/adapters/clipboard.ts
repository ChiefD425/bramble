import { Clipboard } from "@capacitor/clipboard";
import { clipboardClearMs, PREF_CLIPBOARD_SECONDS } from "@core/hooks/usePrefs";
import type { ClipboardAdapter } from "@core/index";
import { mobileStorage } from "./storage";

// Capacitor's clipboard is plain-text on mobile with no built-in timeout, so we run our own
// auto-clear timer, as long as Settings' "Clipboard auto-clear" says. NOTE: a JS timer does not
// survive the app being backgrounded/killed; a hardened build needs a small native plugin (and
// the Android EXTRA_IS_SENSITIVE flag).
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export const mobileClipboard: ClipboardAdapter = {
	async copy(text) {
		await Clipboard.write({ string: text });
		const after = clipboardClearMs(
			await mobileStorage.getMeta(PREF_CLIPBOARD_SECONDS).catch(() => null),
		);
		// Reset after the read, so a copy that overlapped this one can't leave its timer running.
		if (clearTimer) clearTimeout(clearTimer);
		clearTimer = setTimeout(() => {
			void Clipboard.write({ string: "" });
		}, after);
	},
	// Non-sensitive copy (donation address, URL): no auto-clear timer, so it persists.
	async copyPlain(text) {
		await Clipboard.write({ string: text });
	},
};
