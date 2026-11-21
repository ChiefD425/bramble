/** @vitest-environment happy-dom */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SyncedSettingsAccess, SyncedSettingsContext } from "../../hooks/synced-settings";
import type { BreachResult, Entry, LoginEntry } from "../../hooks/useVault";
import { useBreachSweep } from "./useBreachSweep";

const h = vi.hoisted(() => ({
	entries: [] as Entry[],
	saves: [] as BreachResult[][],
	enabled: true,
}));

vi.mock("../../hooks/useVault", () => ({
	useVault: () => ({
		entries: h.entries,
		setEntriesBreach: async (results: BreachResult[]) => {
			h.saves.push(results);
		},
	}),
}));
vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1" }),
}));
vi.mock("../../hooks/usePrefs", () => ({
	usePrefs: () => ({ prefs: { breachCheckEnabled: h.enabled }, loaded: true }),
}));

const login = (id: string): LoginEntry => ({
	id,
	type: "login",
	name: id,
	urls: [],
	username: "u",
	password: `pw-${id}`,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	h.entries = [];
	h.saves = [];
	h.enabled = true;
	fetchMock = vi.fn(async () => new Response(""));
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function Sweep() {
	useBreachSweep();
	return null;
}

const access = (ready: boolean): SyncedSettingsAccess => ({
	settings: undefined,
	ready,
	set: async () => {},
});

function mount(open = true) {
	const view = render(
		<SyncedSettingsContext.Provider value={access(open)}>
			<Sweep />
		</SyncedSettingsContext.Provider>,
	);
	return {
		rerender: (nextOpen = open) =>
			view.rerender(
				<SyncedSettingsContext.Provider value={access(nextOpen)}>
					<Sweep />
				</SyncedSettingsContext.Provider>,
			),
	};
}

const savedIds = () => h.saves.flat().map((r) => r.id);

describe("useBreachSweep", () => {
	it("checks the open vault's due logins and saves the results", async () => {
		h.entries = [login("a"), login("b")];
		mount();
		await waitFor(() => expect(savedIds()).toEqual(["a", "b"]));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(h.saves[0]![0]).toMatchObject({ password: "pw-a", breach: { leaked: false } });
	});

	it("sends nothing while breach checks are off", async () => {
		h.enabled = false;
		h.entries = [login("a")];
		mount();
		await new Promise((r) => setTimeout(r, 20));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("waits for the vault to open", async () => {
		h.entries = [login("a")];
		const view = mount(false);
		await new Promise((r) => setTimeout(r, 20));
		expect(fetchMock).not.toHaveBeenCalled();
		view.rerender(true);
		await waitFor(() => expect(savedIds()).toEqual(["a"]));
	});

	// An import, a save from a page, or a sync while the app is open.
	it("checks a login that arrives after the first pass", async () => {
		h.entries = [login("a")];
		const view = mount();
		await waitFor(() => expect(savedIds()).toEqual(["a"]));
		h.entries = [{ ...login("a"), breach: h.saves[0]![0]!.breach }, login("b")];
		view.rerender();
		await waitFor(() => expect(savedIds()).toEqual(["a", "b"]));
	});

	it("drops results that come back after the vault locked", async () => {
		let answer: (r: Response) => void = () => {};
		fetchMock.mockImplementation(
			() =>
				new Promise<Response>((r) => {
					answer = r;
				}),
		);
		h.entries = [login("a")];
		const view = mount();
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		view.rerender(false);
		answer(new Response(""));
		await new Promise((r) => setTimeout(r, 20));
		expect(h.saves).toEqual([]);
	});
});
