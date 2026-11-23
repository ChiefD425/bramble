import { describe, expect, it } from "vitest";
import { DEFAULT_QUICK_ACCESS_SHORTCUT, formatShortcut, shortcutFromKey } from "./shortcut";

const press = (
	code: string,
	mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
) => ({
	code,
	metaKey: !!mods.meta,
	ctrlKey: !!mods.ctrl,
	altKey: !!mods.alt,
	shiftKey: !!mods.shift,
});

describe("shortcutFromKey", () => {
	it("names the physical key with its modifiers", () => {
		expect(shortcutFromKey(press("KeyK", { meta: true, shift: true }), true)).toBe("Cmd+Shift+K");
		expect(shortcutFromKey(press("Digit1", { ctrl: true, alt: true }), false)).toBe("Ctrl+Alt+1");
		expect(shortcutFromKey(press("Space", { alt: true }), true)).toBe("Alt+Space");
		expect(shortcutFromKey(press("KeyP", { meta: true }), false)).toBe("Super+P");
	});

	it("waits while only modifiers are down", () => {
		expect(shortcutFromKey(press("ShiftLeft", { shift: true }), true)).toBeNull();
		expect(shortcutFromKey(press("MetaLeft", { meta: true }), true)).toBeNull();
	});

	it("refuses keys that would fire while typing", () => {
		expect(shortcutFromKey(press("KeyA"), true)).toBeNull();
		expect(shortcutFromKey(press("KeyA", { shift: true }), true)).toBeNull();
	});
});

describe("formatShortcut", () => {
	it("writes the default the way each platform does", () => {
		expect(formatShortcut(DEFAULT_QUICK_ACCESS_SHORTCUT, true)).toBe("⇧⌘Space");
		expect(formatShortcut(DEFAULT_QUICK_ACCESS_SHORTCUT, false)).toBe("Ctrl+Shift+Space");
	});

	it("orders Mac symbols as macOS does", () => {
		expect(formatShortcut("Cmd+Ctrl+Alt+Shift+K", true)).toBe("⌃⌥⇧⌘K");
	});
});
