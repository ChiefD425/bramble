/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import type { Target } from "../../../../flags";
import { GeneralSection } from "./GeneralSection";

const h = vi.hoisted(() => ({
	passkeyProviderEnabled: false,
	update: (async () => {}) as (key: string, value: unknown) => Promise<void>,
	refreshAutofillIndex: async () => {},
}));

vi.mock("../../../../hooks/usePrefs", () => ({
	usePrefs: () => ({
		prefs: {
			autoLockMinutes: 15,
			clipboardClearSeconds: 30,
			neverSaveSites: [],
			passkeyProviderEnabled: h.passkeyProviderEnabled,
			passkeyConfirmOncePerUnlock: false,
		},
		loaded: true,
		update: h.update,
	}),
}));
vi.mock("../../../../hooks/useVault", () => ({
	useVaultActions: () => ({ readEntries: () => [], refreshAutofillIndex: h.refreshAutofillIndex }),
}));
vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ vaults: [], activeId: null }),
}));
vi.mock("../../../../hooks/useAutostart", () => ({ useAutostart: () => ({ available: false }) }));
vi.mock("../../../hooks/useDefaultPasswordManager", () => ({
	useDefaultPasswordManager: () => null,
}));
vi.mock("../../../hooks/useVaultName", () => ({ useRenameVault: () => vi.fn() }));

function mount(target: Target) {
	const platform = { target, autofill: {}, shell: {} } as unknown as Platform;
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<GeneralSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

function timeoutOptions(): string[] {
	const select = screen.getByLabelText("Timeout") as HTMLSelectElement;
	return Array.from(select.options).map((o) => o.textContent ?? "");
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(cleanup);

describe("GeneralSection auto-lock timeout", () => {
	it("offers no Immediate on desktop, which has no moment the app stops being used", () => {
		mount("desktop");
		expect(timeoutOptions()).not.toContain("Immediate");
		expect(timeoutOptions()).toContain("5 minutes");
	});

	// #188: "Never" read as surviving a restart, which would mean writing the key to disk.
	it.each([
		["chromium", "Until browser closes"],
		["firefox", "Until browser closes"],
		["desktop", "Until Bramble quits"],
		["ios", "Until app closes"],
		["android", "Until app closes"],
	] as [Target, string][])(
		"names the no-timeout option for what ends it on %s",
		(target, label) => {
			mount(target);
			expect(screen.getByRole("option", { name: label })).toHaveProperty("value", "0");
			expect(screen.queryByRole("option", { name: "Never" })).toBeNull();
			cleanup();
		},
	);

	it("offers Immediate in the browser and on phones", () => {
		for (const target of ["chromium", "ios"] as Target[]) {
			mount(target);
			expect(timeoutOptions()).toContain("Immediate");
			cleanup();
		}
	});
});

// Daniel's ask: a site that checks it's you asked for the master password on every passkey use.
describe("GeneralSection passkey confirmation", () => {
	const toggle = () =>
		screen.queryByRole("button", { name: "Toggle confirm passkeys once per unlock" });

	beforeEach(() => {
		h.passkeyProviderEnabled = false;
		h.update = vi.fn(async () => {});
	});

	it("offers once per unlock only while Bramble handles passkeys", () => {
		mount("chromium");
		expect(toggle()).toBeNull();
		cleanup();
		h.passkeyProviderEnabled = true;
		mount("chromium");
		expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("saves the choice", () => {
		h.passkeyProviderEnabled = true;
		mount("firefox");
		const button = toggle();
		if (!button) throw new Error("no toggle");
		fireEvent.click(button);
		expect(h.update).toHaveBeenCalledWith("passkeyConfirmOncePerUnlock", true);
	});

	it("isn't on phones or the desktop app, where the OS asks", () => {
		h.passkeyProviderEnabled = true;
		for (const target of ["ios", "android", "desktop"] as Target[]) {
			mount(target);
			expect(toggle()).toBeNull();
			cleanup();
		}
	});
});

describe("GeneralSection keyboard suggestions", () => {
	it("saves the choice, then has the AutoFill copy rewritten to carry it", async () => {
		const calls: string[] = [];
		h.update = async (key, value) => void calls.push(`update:${key}=${value}`);
		h.refreshAutofillIndex = async () => void calls.push("refresh");
		const platform = {
			target: "ios",
			autofill: { setKeepUnlocked: async () => {}, inlineSuggestionsAvailable: async () => true },
			shell: {},
		} as unknown as Platform;
		render(
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={platform}>
					<GeneralSection />
				</PlatformProvider>
			</I18nProvider>,
		);
		fireEvent.click(await screen.findByLabelText("Toggle keyboard suggestions"));
		await vi.waitFor(() => expect(calls).toEqual(["update:autofillQuickType=true", "refresh"]));
	});
});

describe("GeneralSection AutoFill suggestions on the Mac", () => {
	it("is offered under its Mac name, saved, then sent to macOS when switched on", async () => {
		const calls: string[] = [];
		h.update = async (key, value) => void calls.push(`update:${key}=${value}`);
		h.refreshAutofillIndex = async () => void calls.push("refresh");
		const platform = {
			target: "desktop",
			autofill: { inlineSuggestionsAvailable: async () => true },
			shell: {},
		} as unknown as Platform;
		render(
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={platform}>
					<GeneralSection />
				</PlatformProvider>
			</I18nProvider>,
		);
		fireEvent.click(await screen.findByLabelText("Toggle AutoFill suggestions"));
		await vi.waitFor(() => expect(calls).toEqual(["update:autofillQuickType=true", "refresh"]));
		expect(screen.getByText("AutoFill suggestions")).toBeTruthy();
		expect(screen.queryByText("Keyboard suggestions")).toBeNull();
	});
});
