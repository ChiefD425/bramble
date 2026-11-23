/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { Target } from "../../flags";
import { PrefsProvider } from "../../hooks/usePrefs";
import { WhatsNewCard } from "../components/WhatsNewCard";
import type { ReleaseNotes } from "../whats-new";
import { useWhatsNew } from "./useWhatsNew";

// An install with a vault, so the fresh-install baseline stays out of the way.
vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1", vaults: [{ id: "v1" }], ready: true }),
}));

const load = vi.hoisted(() => vi.fn());
vi.mock("../whats-new", async (original) => ({
	...(await original<typeof import("../whats-new")>()),
	loadReleaseNotes: load,
}));

const NOTES: ReleaseNotes = {
	version: "1.42.0",
	headline: "Fill from Bramble's window.",
	items: ["A Fill button for matching logins.", "Shift-click selects a range."],
};

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	load.mockReset();
	load.mockImplementation(async (_t: Target, _l: string, installed: string) =>
		installed === NOTES.version ? NOTES : null,
	);
});

afterEach(cleanup);

function Notice() {
	const notice = useWhatsNew();
	return notice ? <WhatsNewCard notice={notice} /> : null;
}

async function mount(
	version: string,
	store = new Map<string, unknown>(),
	target: Target = "chromium",
) {
	const storage = {
		getMeta: vi.fn(async (k: string) => store.get(k)),
		setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
		removeMeta: vi.fn(async (k: string) => void store.delete(k)),
	};
	const platform = { storage, target, shell: { version } } as unknown as Platform;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<Notice />
				</PrefsProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	await act(async () => {});
	await act(async () => {});
	return store;
}

const title = () => screen.queryByText("What's new in 1.42.0");

describe("useWhatsNew", () => {
	it("shows the build's notes after an update", async () => {
		await mount("1.42.0", new Map([["pref.whatsNew", { seen: "1.41.0" }]]));
		expect(title()).toBeTruthy();
		expect(screen.getByText("Fill from Bramble's window.")).toBeTruthy();
		expect(load).toHaveBeenCalledWith("chromium", "en", "1.42.0");
	});

	it("shows them once to an install from before the feature", async () => {
		await mount("1.42.0");
		expect(title()).toBeTruthy();
	});

	it("shows nothing for the version already seen", async () => {
		await mount("1.42.0", new Map([["pref.whatsNew", { seen: "1.42.0" }]]));
		expect(title()).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it("shows nothing when the build carries no notes for its version", async () => {
		await mount("1.43.0", new Map([["pref.whatsNew", { seen: "1.42.0" }]]));
		expect(load).toHaveBeenCalledWith("chromium", "en", "1.43.0");
		expect(screen.queryByText(/What's new/)).toBeNull();
	});

	it("shows nothing on a dev build", async () => {
		await mount("0.0.0");
		expect(screen.queryByText(/What's new/)).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it("drops the build number from a mobile version", async () => {
		await mount("1.42.0 (217447763)", new Map(), "android");
		expect(load).toHaveBeenCalledWith("android", "en", "1.42.0");
		expect(title()).toBeTruthy();
	});

	it("ends with the close button, for this version only", async () => {
		const store = await mount("1.42.0", new Map([["pref.whatsNew", { seen: "1.41.0" }]]));
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		await act(async () => {});
		expect(title()).toBeNull();
		expect(store.get("pref.whatsNew")).toEqual({ seen: "1.42.0" });
	});

	it("ends with Read more, which opens the release's page", async () => {
		const store = await mount("1.42.0");
		const link = screen.getByRole("link", { name: /read more/i });
		expect(link.getAttribute("href")).toBe("https://bramble.sh/whats-new/chromium/1.42.0");
		expect(link.getAttribute("target")).toBe("_blank");
		fireEvent.click(link);
		await act(async () => {});
		expect(title()).toBeNull();
		expect(store.get("pref.whatsNew")).toEqual({ seen: "1.42.0" });
	});
});

describe("useWhatsNew while the notes load", () => {
	function State() {
		const notice = useWhatsNew();
		return <div>{notice === undefined ? "loading" : notice ? "card" : "none"}</div>;
	}

	async function mountState(version: string, seen?: string) {
		const store = new Map<string, unknown>(seen ? [["pref.whatsNew", { seen }]] : []);
		const storage = {
			getMeta: vi.fn(async (k: string) => store.get(k)),
			setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
			removeMeta: vi.fn(async (k: string) => void store.delete(k)),
		};
		const platform = { storage, target: "ios", shell: { version } } as unknown as Platform;
		render(
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={platform}>
					<PrefsProvider>
						<State />
					</PrefsProvider>
				</PlatformProvider>
			</I18nProvider>,
		);
		await act(async () => {});
	}

	it("is undefined until they arrive, so iOS's review prompt can wait for the answer", async () => {
		let resolve: (n: ReleaseNotes | null) => void = () => {};
		load.mockImplementation(() => new Promise((r) => (resolve = r)));
		await mountState("1.42.0");
		expect(screen.getByText("loading")).toBeTruthy();
		await act(async () => resolve(NOTES));
		expect(screen.getByText("card")).toBeTruthy();
	});

	it("is null at once when nothing is due", async () => {
		await mountState("1.42.0", "1.42.0");
		expect(screen.getByText("none")).toBeTruthy();
	});

	it("is null when the build has no notes for its version", async () => {
		await mountState("1.43.0", "1.42.0");
		expect(screen.getByText("none")).toBeTruthy();
	});
});

describe("WhatsNewCard", () => {
	it("keeps the changes folded until asked for", async () => {
		await mount("1.42.0");
		expect(screen.queryByText("Shift-click selects a range.")).toBeNull();
		const toggle = screen.getByRole("button", { name: /show 2 changes/i });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(screen.getByText("Shift-click selects a range.")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /hide changes/i }).getAttribute("aria-expanded"),
		).toBe("true");
	});

	it("has no toggle when the notes are a headline alone", async () => {
		load.mockImplementation(async () => ({ version: "1.42.0", headline: "Just this.", items: [] }));
		await mount("1.42.0");
		expect(screen.getByText("Just this.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /show/i })).toBeNull();
	});
});
