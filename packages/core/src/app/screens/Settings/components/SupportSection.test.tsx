/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import type { Target } from "../../../../flags";
import { PrefsProvider } from "../../../../hooks/usePrefs";
import { SupportSection } from "./SupportSection";

vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1", vaults: [{ id: "v1" }], ready: true }),
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(cleanup);

async function mount(target: Target, store = new Map<string, unknown>()) {
	const storage = {
		getMeta: vi.fn(async (k: string) => store.get(k)),
		setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
		removeMeta: vi.fn(async (k: string) => void store.delete(k)),
	};
	const platform = {
		storage,
		target,
		shell: { version: "1.42.0" },
		clipboard: {},
	} as unknown as Platform;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<SupportSection />
				</PrefsProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	await act(async () => {});
	return store;
}

const reminder = () => screen.queryByRole("button", { name: "Remind me every two weeks" });

describe("SupportSection", () => {
	it("offers Ko-fi and the reminder's switch, on by default", async () => {
		await mount("chromium");
		const kofi = screen.getByRole("link", { name: /Donate on Ko-fi/ });
		expect(kofi.getAttribute("href")).toBe("https://ko-fi.com/bramble_sh");
		expect(kofi.getAttribute("target")).toBe("_blank");
		expect(reminder()?.getAttribute("aria-pressed")).toBe("true");
	});

	it("turns the reminder off on this device", async () => {
		const store = await mount("android");
		fireEvent.click(reminder() as HTMLElement);
		await act(async () => {});
		expect(store.get("pref.supportAskEnabled")).toBe(false);
		expect(reminder()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("has neither on iOS, which never asks", async () => {
		await mount("ios");
		expect(screen.queryByRole("link", { name: /Ko-fi/ })).toBeNull();
		expect(reminder()).toBeNull();
		expect(screen.getByText("Monero")).toBeTruthy();
	});
});
