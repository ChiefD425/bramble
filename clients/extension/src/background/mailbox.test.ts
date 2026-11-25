import { describe, expect, it, vi } from "vitest";

type Handler = (message: unknown) => Promise<unknown>;
const { handlers, driver } = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	driver: {
		syncNow: vi.fn(async () => "synced"),
		members: vi.fn(async (): Promise<unknown> => null),
		retarget: vi.fn(),
		changed: vi.fn(),
		alarm: vi.fn(),
		current: vi.fn(),
	},
}));
vi.mock("./router", () => ({
	on: (type: string, handler: Handler) => handlers.set(type, handler),
	extensionOnly: (fn: Handler) => fn,
}));
vi.mock("@core/sync/mailbox", async (importOriginal) => ({
	...(await importOriginal<typeof import("@core/sync/mailbox")>()),
	createMailboxDriver: () => driver,
}));
vi.mock("./mailbox-ports", () => ({ buildMailboxEngine: vi.fn(), mailboxIdentity: vi.fn() }));
vi.mock("./sync", () => ({ readLocalState: vi.fn() }));
vi.mock("./offscreen-client", () => ({ useOffscreenDoc: false }));
vi.mock("./event-page-keepalive", () => ({ keepEventPageAlive: vi.fn() }));
vi.mock("../sync/sync-config", () => ({ resolveSyncVault: vi.fn() }));
vi.mock("../platform-api", () => ({ api: { storage: { local: {}, session: {} }, alarms: {} } }));

import "./mailbox";

describe("the mailbox's background messages", () => {
	it("answers MAILBOX_SYNC_NOW with the round's status", async () => {
		const answer = await handlers.get("MAILBOX_SYNC_NOW")?.({ type: "MAILBOX_SYNC_NOW" });
		expect(answer).toEqual({ ok: true, data: "synced" });
	});

	it("answers MAILBOX_MEMBERS from the engine's api, or null with none", async () => {
		expect(await handlers.get("MAILBOX_MEMBERS")?.({})).toEqual({ ok: true, data: null });
		const members = [{ sigKey: "K", status: "active", lastCheckedDay: 1 }];
		driver.members.mockResolvedValueOnce(members);
		expect(await handlers.get("MAILBOX_MEMBERS")?.({})).toEqual({ ok: true, data: members });
	});
});
