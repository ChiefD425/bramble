import { beforeEach, describe, expect, it, vi } from "vitest";

// The launch-check setting. The privacy policy says the desktop app checks for updates when it
// opens and that this can be turned off, so the default and the off switch are both promises.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	install: async (_onEvent: { onmessage: (e: unknown) => void }): Promise<boolean> => true,
	relaunched: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args?: { onEvent: { onmessage: (e: unknown) => void } }) =>
		cmd === "updates_install" && args ? h.install(args.onEvent) : true,
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@tauri-apps/plugin-process", () => ({
	relaunch: async () => {
		h.relaunched++;
	},
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
vi.mock("./storage", () => ({
	desktopStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => {
			h.meta.set(k, v);
		},
	},
}));

const { desktopUpdates } = await import("./updates");

beforeEach(() => {
	h.meta = new Map();
	h.relaunched = 0;
});

describe("checkOnLaunch", () => {
	it("is on for a fresh install", async () => {
		// Nothing stored yet is the state most people stay in, and a fix that reaches nobody
		// fixes nothing.
		expect(await desktopUpdates.checkOnLaunch?.()).toBe(true);
	});

	it("stays off once turned off", async () => {
		await desktopUpdates.setCheckOnLaunch?.(false);

		expect(await desktopUpdates.checkOnLaunch?.()).toBe(false);
	});

	it("turns back on", async () => {
		await desktopUpdates.setCheckOnLaunch?.(false);
		await desktopUpdates.setCheckOnLaunch?.(true);

		expect(await desktopUpdates.checkOnLaunch?.()).toBe(true);
	});
});

// Installing goes through Rust, which also requires the build to be in the public log
// (src-tauri/src/updates.rs); this side only shows progress and relaunches.
describe("install", () => {
	function watch(): (number | null | undefined)[] {
		const seen: (number | null | undefined)[] = [];
		desktopUpdates.onProgress?.((v) => seen.push(v));
		return seen;
	}

	it("shows the download's progress, then relaunches", async () => {
		h.install = async (onEvent) => {
			onEvent.onmessage({ event: "Started", data: { contentLength: 4 } });
			onEvent.onmessage({ event: "Progress", data: { chunkLength: 1 } });
			onEvent.onmessage({ event: "Progress", data: { chunkLength: 3 } });
			onEvent.onmessage({ event: "Finished" });
			return true;
		};
		const seen = watch();

		await desktopUpdates.install?.();

		expect(seen.slice(1)).toEqual([0, 0.25, 1, 1]);
		expect(h.relaunched).toBe(1);
	});

	it("does not relaunch when there turned out to be no update", async () => {
		h.install = async () => false;
		const seen = watch();

		await desktopUpdates.install?.();

		expect(h.relaunched).toBe(0);
		expect(seen.at(-1)).toBeUndefined();
	});

	it("goes back to idle and reports a refused update", async () => {
		h.install = async (onEvent) => {
			onEvent.onmessage({ event: "Started", data: { contentLength: 4 } });
			throw "this update is not in the public log";
		};
		const seen = watch();

		await expect(desktopUpdates.install?.()).rejects.toBe("this update is not in the public log");

		expect(h.relaunched).toBe(0);
		expect(seen.at(-1)).toBeUndefined();
	});
});
