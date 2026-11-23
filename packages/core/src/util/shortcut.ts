/** Quick Access's shortcut when none was chosen; matches HOTKEY in the desktop's spotlight.rs. */
export const DEFAULT_QUICK_ACCESS_SHORTCUT = "CmdOrCtrl+Shift+Space";

type KeyPress = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const MODIFIER_CODES = new Set([
	"ShiftLeft",
	"ShiftRight",
	"ControlLeft",
	"ControlRight",
	"AltLeft",
	"AltRight",
	"MetaLeft",
	"MetaRight",
	"OSLeft",
	"OSRight",
	"CapsLock",
	"Fn",
]);

/**
 * The accelerator a key press names ("Cmd+Shift+K"), or null while only modifiers are down or
 * when it has no Cmd, Ctrl or Alt: Shift alone, or a bare key, would fire in the middle of typing.
 * Named by `code`, the physical key, as the desktop's hotkey library expects.
 */
export function shortcutFromKey(press: KeyPress, mac: boolean): string | null {
	if (!press.code || MODIFIER_CODES.has(press.code)) return null;
	if (!press.metaKey && !press.ctrlKey && !press.altKey) return null;
	const key = press.code.startsWith("Key")
		? press.code.slice(3)
		: press.code.startsWith("Digit")
			? press.code.slice(5)
			: press.code;
	const parts: string[] = [];
	if (press.metaKey) parts.push(mac ? "Cmd" : "Super");
	if (press.ctrlKey) parts.push("Ctrl");
	if (press.altKey) parts.push("Alt");
	if (press.shiftKey) parts.push("Shift");
	return [...parts, key].join("+");
}

// macOS writes modifiers as symbols, in a fixed order: Control, Option, Shift, Command.
const MAC_SYMBOLS: Record<string, string> = {
	CTRL: "⌃",
	CONTROL: "⌃",
	ALT: "⌥",
	OPTION: "⌥",
	SHIFT: "⇧",
	CMD: "⌘",
	COMMAND: "⌘",
	SUPER: "⌘",
	CMDORCTRL: "⌘",
	COMMANDORCONTROL: "⌘",
};
const MAC_ORDER = "⌃⌥⇧⌘";
const NAMES: Record<string, string> = {
	CTRL: "Ctrl",
	CONTROL: "Ctrl",
	ALT: "Alt",
	OPTION: "Alt",
	SHIFT: "Shift",
	CMD: "Super",
	COMMAND: "Super",
	SUPER: "Super",
	CMDORCTRL: "Ctrl",
	COMMANDORCONTROL: "Ctrl",
};

/** An accelerator as the platform writes it: "⇧⌘Space" on a Mac, "Ctrl+Shift+Space" elsewhere. */
export function formatShortcut(accelerator: string, mac: boolean): string {
	const parts = accelerator.split("+");
	const key = parts.pop() ?? "";
	if (mac) {
		const mods = parts
			.map((p) => MAC_SYMBOLS[p.toUpperCase()] ?? p)
			.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
		return `${mods.join("")}${key}`;
	}
	return [...parts.map((p) => NAMES[p.toUpperCase()] ?? p), key].join("+");
}
