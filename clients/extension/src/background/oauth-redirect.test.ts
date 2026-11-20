import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureRedirectFromTab,
	isGeckoRedirect,
	loopbackRedirectUri,
	type TabsLike,
} from "./oauth-redirect";

const CHROME = "https://kmokhdhoggbdcgoepifeckhgbfakaknm.chromiumapp.org/";
const FIREFOX = "https://2f8e3a1b9c.extensions.allizom.org/";

describe("loopbackRedirectUri", () => {
	it("on Firefox, is the mozoauth2 loopback launchWebAuthFlow accepts", () => {
		expect(isGeckoRedirect(FIREFOX)).toBe(true);
		expect(loopbackRedirectUri(FIREFOX, 4711)).toBe("http://127.0.0.1/mozoauth2/2f8e3a1b9c");
	});

	it("on Chromium, is a loopback on the given port, for a tab to land on", () => {
		expect(isGeckoRedirect(CHROME)).toBe(false);
		expect(loopbackRedirectUri(CHROME, 4711)).toBe("http://127.0.0.1:4711/");
	});
});

type Listener<A extends unknown[]> = (...args: A) => void;

/** A tabs API whose events the test fires by hand. */
function fakeTabs() {
	const updated = new Set<Listener<[number, { url?: string }, { url?: string }]>>();
	const removed = new Set<Listener<[number]>>();
	const tabs = {
		create: vi.fn(async (_: { url: string }) => ({ id: 7 })),
		remove: vi.fn(async (_: number) => {}),
		onUpdated: {
			addListener: (l: Listener<[number, { url?: string }, { url?: string }]>) => updated.add(l),
			removeListener: (l: Listener<[number, { url?: string }, { url?: string }]>) =>
				updated.delete(l),
		},
		onRemoved: {
			addListener: (l: Listener<[number]>) => removed.add(l),
			removeListener: (l: Listener<[number]>) => removed.delete(l),
		},
	} satisfies TabsLike;
	return {
		tabs,
		navigate: (id: number, url: string) => {
			for (const l of [...updated]) l(id, { url }, { url });
		},
		close: (id: number) => {
			for (const l of [...removed]) l(id);
		},
		listeners: () => updated.size + removed.size,
	};
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const REDIRECT = "http://127.0.0.1:4711/";

describe("captureRedirectFromTab", () => {
	afterEach(() => vi.useRealTimers());

	it("opens the consent page in a tab and returns the URL it is sent back to, closing the tab", async () => {
		const f = fakeTabs();
		const got = captureRedirectFromTab(f.tabs, "https://accounts.example/auth", REDIRECT);
		await settle();
		expect(f.tabs.create).toHaveBeenCalledWith({ url: "https://accounts.example/auth" });

		f.navigate(7, "https://accounts.example/consent");
		f.navigate(9, `${REDIRECT}?code=OTHER`);
		f.navigate(7, `${REDIRECT}?state=s&code=C`);

		await expect(got).resolves.toBe(`${REDIRECT}?state=s&code=C`);
		expect(f.tabs.remove).toHaveBeenCalledWith(7);
		expect(f.listeners()).toBe(0);
	});

	it("is undefined when the user closes the tab", async () => {
		const f = fakeTabs();
		const got = captureRedirectFromTab(f.tabs, "https://accounts.example/auth", REDIRECT);
		await settle();
		f.close(7);
		await expect(got).resolves.toBeUndefined();
		expect(f.tabs.remove).not.toHaveBeenCalled();
		expect(f.listeners()).toBe(0);
	});

	it("gives up and closes the tab after the timeout", async () => {
		vi.useFakeTimers();
		const f = fakeTabs();
		const got = captureRedirectFromTab(f.tabs, "https://accounts.example/auth", REDIRECT, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		await expect(got).resolves.toBeUndefined();
		expect(f.tabs.remove).toHaveBeenCalledWith(7);
		expect(f.listeners()).toBe(0);
	});
});
