import { describe, expect, it, vi } from "vitest";

// What the mobile binding decides on its own: how a vault's blobs move. The wiring itself is
// core's (sync/mailbox/in-process.ts) and is tested there.

const h = vi.hoisted(() => ({ native: true }));

vi.mock("@capacitor/app", () => ({
	App: { addListener: async () => ({ remove: async () => {} }) },
}));
vi.mock("@capacitor/core", () => ({
	Capacitor: { isNativePlatform: () => h.native, getPlatform: () => "ios" },
	registerPlugin: () => ({}),
}));
vi.mock("@core/sync/mailbox", async (importOriginal) => ({
	...(await importOriginal<typeof import("@core/sync/mailbox")>()),
	storeBlobMover: () => "js-mover",
}));
vi.mock("./sync-manager", () => ({
	activeVaultId: vi.fn(),
	mailboxVaultDeps: vi.fn(),
	queueApply: vi.fn(),
	refusedFor: vi.fn(),
	rosterVerify: vi.fn(),
	signRoster: vi.fn(),
	storedGroup: vi.fn(),
	syncSigningPublicKey: vi.fn(),
}));
vi.mock("./blob-mover", () => ({ nativeBlobMover: () => "native-mover" }));
vi.mock("../adapters/http", () => ({ mobileHttp: {} }));
vi.mock("../adapters/files", () => ({ mobileFiles: { forVault: () => ({ blobs: "store" }) } }));
vi.mock("../adapters/crypto", () => ({ mobileCrypto: {} }));
vi.mock("../adapters/storage", () => ({ mobileStorage: {}, onVaultWritten: () => () => {} }));
vi.mock("../adapters/vault-session", () => ({ onVaultStateChange: () => () => {} }));

const { mailboxBlobs } = await import("./mailbox");

describe("the mobile mailbox's blobs", () => {
	it("move natively on a device, and through the JS mover in the web build", () => {
		h.native = true;
		expect(mailboxBlobs("v")).toEqual({ store: "store", mover: "native-mover" });
		h.native = false;
		expect(mailboxBlobs("v")).toEqual({ store: "store", mover: "js-mover" });
	});
});
