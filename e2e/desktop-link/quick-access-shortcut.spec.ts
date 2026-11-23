import { desk, expect, test } from "./fixtures";

// Quick Access's shortcut lives in Rust: the global registration, the stored choice and the tray's
// label (#227). Each change is a real system-wide registration, so this spec has its own app, uses
// keys nothing else on the machine is likely to hold, and leaves the shortcut off.
test.use({ ownApp: true });

const invoke = <T = unknown>(cmd: string, args: Record<string, unknown> = {}) =>
	desk<T>(
		`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});`,
	);

test("changes, refuses and turns off the Quick Access shortcut (#227)", async ({ desktop }) => {
	void desktop;
	const chosen = "Ctrl+Alt+Shift+F9";
	await invoke("spotlight_set_shortcut", { shortcut: chosen });
	expect(await invoke("spotlight_shortcut")).toBe(chosen);

	// Keys the hotkey library can't name are refused, and the working shortcut stays.
	await expect(invoke("spotlight_set_shortcut", { shortcut: "Ctrl+NotAKey" })).rejects.toThrow();
	expect(await invoke("spotlight_shortcut")).toBe(chosen);

	// Settings shows it the way the platform writes it.
	const label = await desk<string>(`
		await front();
		await click(/^Settings$/);
		await click(/^General$/);
		const b = await waitFor(() => document.querySelector('[aria-label="Change the Quick Access shortcut"]'));
		return b.textContent.trim();
	`);
	expect(label).toBe("⌃⌥⇧F9");

	await invoke("spotlight_set_shortcut", { shortcut: null });
	expect(await invoke("spotlight_shortcut")).toBeNull();
});
