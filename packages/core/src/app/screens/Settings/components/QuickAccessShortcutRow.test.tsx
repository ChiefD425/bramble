/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { QuickAccessShortcutRow } from "./QuickAccessShortcutRow";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(cleanup);

function mount(current: string | null, set = vi.fn(async (_s: string | null) => {})) {
	const shell = { quickAccessShortcut: { get: async () => current, set } };
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={{ target: "desktop", shell } as unknown as Platform}>
				<QuickAccessShortcutRow />
			</PlatformProvider>
		</I18nProvider>,
	);
	return { set };
}

const change = () => screen.findByRole("button", { name: "Change the Quick Access shortcut" });

describe("Quick Access shortcut (#227)", () => {
	it("records the next shortcut pressed and saves it", async () => {
		const { set } = mount("CmdOrCtrl+Shift+Space");
		fireEvent.click(await change());
		const recorder = screen.getByRole("button", { name: "Press the new shortcut" });
		fireEvent.keyDown(recorder, { code: "AltLeft", key: "Alt", altKey: true }); // still choosing
		expect(set).not.toHaveBeenCalled();
		fireEvent.keyDown(recorder, { code: "KeyK", key: "k", altKey: true, ctrlKey: true });
		await waitFor(() => expect(set).toHaveBeenCalledExactlyOnceWith("Ctrl+Alt+K"));
	});

	it("keeps the old one and says so when the keys can't be used", async () => {
		const set = vi.fn(async () => {
			throw new Error("HotKey already registered");
		});
		mount("CmdOrCtrl+Shift+Space", set);
		fireEvent.click(await change());
		fireEvent.keyDown(screen.getByRole("button", { name: "Press the new shortcut" }), {
			code: "KeyK",
			key: "k",
			ctrlKey: true,
		});
		expect(await screen.findByText(/That shortcut is taken/)).toBeTruthy();
		expect(await change()).toBeTruthy();
	});

	it("turns off, and back on at the default", async () => {
		const { set } = mount("CmdOrCtrl+Shift+Space");
		await change();
		fireEvent.click(screen.getByRole("button", { name: "Toggle the Quick Access shortcut" }));
		await waitFor(() => expect(set).toHaveBeenLastCalledWith(null));
		expect(screen.queryByRole("button", { name: "Change the Quick Access shortcut" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Toggle the Quick Access shortcut" }));
		await waitFor(() => expect(set).toHaveBeenLastCalledWith("CmdOrCtrl+Shift+Space"));
	});
});
