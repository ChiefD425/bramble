/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { Target } from "../../flags";
import { PrefsProvider } from "../../hooks/usePrefs";
import { SupportSheet } from "../components/SupportSheet";
import { useSupportAsk } from "./useSupportAsk";

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1", vaults: [{ id: "v1" }], ready: true }),
}));

const DAY = 24 * 60 * 60 * 1000;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(cleanup);

function Ask({ hold = false }: { hold?: boolean }) {
	const ask = useSupportAsk(hold);
	return ask ? <SupportSheet ask={ask} /> : null;
}

async function mount(
	store: Map<string, unknown>,
	{ target = "chromium", hold = false }: { target?: Target; hold?: boolean } = {},
) {
	const storage = {
		getMeta: vi.fn(async (k: string) => store.get(k)),
		setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
		removeMeta: vi.fn(async (k: string) => void store.delete(k)),
	};
	const platform = { storage, target, shell: { version: "1.42.0" } } as unknown as Platform;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<PrefsProvider>
					<Ask hold={hold} />
				</PrefsProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	await act(async () => {});
	await act(async () => {});
}

const due = () =>
	new Map<string, unknown>([["pref.supportAsk", { startedAt: Date.now() - 15 * DAY }]]);
const sheet = () => screen.queryByRole("dialog", { name: "Support Bramble" });

describe("useSupportAsk", () => {
	it("starts the clock on the first run and asks nothing yet", async () => {
		const store = new Map<string, unknown>();
		await mount(store);
		expect(sheet()).toBeNull();
		const { startedAt } = store.get("pref.supportAsk") as { startedAt: number };
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("asks two weeks in, and counts it as asked the moment it shows", async () => {
		const store = due();
		await mount(store);
		expect(sheet()).toBeTruthy();
		const { askedAt } = store.get("pref.supportAsk") as { askedAt: number };
		expect(Date.now() - askedAt).toBeLessThan(5_000);
	});

	it("goes with Not now, and is not back on the next open", async () => {
		const store = due();
		await mount(store);
		fireEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(sheet()).toBeNull();
		cleanup();
		await mount(store);
		expect(sheet()).toBeNull();
	});

	it("opens Ko-fi from Donate, and records it so the next ask waits 90 days", async () => {
		const store = due();
		await mount(store);
		const donate = screen.getByRole("link", { name: /Donate/ });
		expect(donate.getAttribute("href")).toBe("https://ko-fi.com/bramble_sh");
		expect(donate.getAttribute("target")).toBe("_blank");
		fireEvent.click(donate);
		await act(async () => {});
		expect(sheet()).toBeNull();
		expect((store.get("pref.supportAsk") as { donatedAt?: number }).donatedAt).toBeTypeOf("number");
	});

	it("never asks on iOS, where App Review refuses an external tip link", async () => {
		await mount(due(), { target: "ios" });
		expect(sheet()).toBeNull();
	});

	it("never asks with the Settings switch off", async () => {
		const store = due();
		store.set("pref.supportAskEnabled", false);
		await mount(store);
		expect(sheet()).toBeNull();
	});

	it("waits while another card holds the spot, without spending the ask", async () => {
		const store = due();
		await mount(store, { hold: true });
		expect(sheet()).toBeNull();
		expect((store.get("pref.supportAsk") as { askedAt?: number }).askedAt).toBeUndefined();
	});

	it("closes on Escape like any dialog", async () => {
		await mount(due());
		fireEvent.keyDown(window, { key: "Escape" });
		expect(sheet()).toBeNull();
	});
});
