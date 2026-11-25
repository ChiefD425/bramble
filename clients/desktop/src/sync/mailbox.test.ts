import { can } from "@core/flags";
import type { InProcessMailboxPlatform } from "@core/sync/mailbox";
import { describe, expect, it, vi } from "vitest";

// What the desktop binding decides on its own: the tick it runs on and how blobs move. The wiring
// itself is core's (sync/mailbox/in-process.ts) and is tested there.

const h = vi.hoisted(() => ({
	platform: null as InProcessMailboxPlatform | null,
	listened: [] as { event: string; handler: () => void }[],
	unlistened: 0,
	focus: null as ((event: { payload: boolean }) => void) | null,
}));

vi.mock("@core/sync/mailbox", async (importOriginal) => ({
	...(await importOriginal<typeof import("@core/sync/mailbox")>()),
	createInProcessMailbox: (platform: InProcessMailboxPlatform) => {
		h.platform = platform;
		return { driver: {}, init: () => () => {}, vaultSwitching: () => {} };
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (event: string, handler: () => void) => {
		h.listened.push({ event, handler });
		return () => {
			h.unlistened++;
		};
	},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		onFocusChanged: async (handler: (event: { payload: boolean }) => void) => {
			h.focus = handler;
			return () => {};
		},
	}),
}));
vi.mock("./blob-mover", () => ({ desktopBlobMover: () => "desktop-mover" }));
vi.mock("../adapters/files", () => ({ desktopFiles: { forVault: () => ({ blobs: "store" }) } }));

await import("./mailbox");

function platform(): InProcessMailboxPlatform {
	if (!h.platform) throw new Error("the mailbox was not created");
	return h.platform;
}

describe("the desktop mailbox", () => {
	it("runs on the shell's 5-minute tick, which a hidden window does not throttle", async () => {
		const ticks: number[] = [];
		const off = platform().onTick(() => ticks.push(1));
		await vi.waitFor(() => expect(h.listened).toHaveLength(1));
		expect(h.listened[0]?.event).toBe("backup://tick");
		h.listened[0]?.handler();
		expect(ticks).toEqual([1]);
		off();
		await vi.waitFor(() => expect(h.unlistened).toBe(1));
	});

	it("asks for a round when the window comes back, as opening it from the tray does", async () => {
		const wakes: number[] = [];
		platform().onWake?.(() => wakes.push(1));
		await vi.waitFor(() => expect(h.focus).not.toBeNull());
		h.focus?.({ payload: false });
		expect(wakes).toEqual([]);
		h.focus?.({ payload: true });
		expect(wakes).toEqual([1]);
	});

	it("moves blobs through the desktop mover", () => {
		expect(platform().blobs("v")).toEqual({ store: "store", mover: "desktop-mover" });
		expect(platform().hosted).toBe(can("mailboxHosted", "desktop"));
	});
});
