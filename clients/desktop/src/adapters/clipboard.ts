import type { ClipboardAdapter } from "@core/adapters/clipboard";
import { clipboardClearMs, PREF_CLIPBOARD_SECONDS } from "@core/hooks/usePrefs";
import { clear, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { desktopStorage } from "./storage";

let pending: ReturnType<typeof setTimeout> | null = null;

export const desktopClipboard: ClipboardAdapter = {
	async copy(text: string) {
		await writeText(text);
		// As long as Settings' "Clipboard auto-clear" says, read at each copy.
		const after = clipboardClearMs(
			await desktopStorage.getMeta(PREF_CLIPBOARD_SECONDS).catch(() => null),
		);
		// Only the most recent copy is worth clearing; an older timer would wipe it early. Reset
		// after the read, so a copy that overlapped this one can't leave its timer running.
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			// Best-effort: the user may have copied something else since, and clearing that
			// would be worse than leaving ours. Reading first needs clipboard read permission,
			// so for now accept the small window. Revisit with the spotlight work.
			void clear().catch(() => {});
		}, after);
	},
};
