import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #27 on desktop: one VEK for the process, so before the app records a new active vault,
// the mailbox and P2P must both have stopped writing to the old one, the mailbox first.

const h = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: async () => null }));
vi.mock("../sync/bus", () => ({ onSyncEvent: () => () => {}, onSyncStatus: () => () => {} }));
vi.mock("../sync/keys", () => ({
	signRoster: vi.fn(),
	syncAdmissionPublicKey: vi.fn(),
	syncAdmissionSign: vi.fn(),
	syncDevicePublicKey: vi.fn(),
	syncSigningPublicKey: vi.fn(),
}));
vi.mock("../sync/transport", () => ({
	approveEnrollment: vi.fn(),
	getPendingEnrollApproval: vi.fn(),
	resetSyncState: vi.fn(),
	startEnrollInvite: vi.fn(),
	startEnrollJoin: vi.fn(),
	stopEnrollInvite: vi.fn(),
	stopSync: vi.fn(),
}));
vi.mock("./stream", () => ({ streamInto: async () => null }));
vi.mock("./updates", () => ({
	canSelfUpdate: () => false,
	desktopUpdates: {},
	resolveUpdatability: async () => {},
}));
vi.mock("../sync/roster", () => ({
	rosterChangedHere: async () => {},
	restartRosterSync: async () => {},
	ACTIVE_VAULT_KEY: "active-vault",
	retargetActiveVault: async (next: string | null) => {
		h.order.push(`p2p:${next}`);
	},
}));
vi.mock("./storage", () => ({
	desktopStorage: {
		setMeta: async (key: string, value: unknown) => {
			h.order.push(`record:${key}=${value}`);
		},
		removeMeta: async (key: string) => {
			h.order.push(`remove:${key}`);
		},
	},
}));
vi.mock("../sync/mailbox", () => ({
	mailboxVaultSwitching: (next: string | null) => h.order.push(`mailbox:${next}`),
	mailboxDriver: {
		syncNow: async () => "synced",
		members: async () => [{ sigKey: "K", status: "active", lastCheckedDay: 1 }],
	},
}));

const { desktopShell } = await import("./shell");

beforeEach(() => {
	h.order.length = 0;
});

describe("the desktop shell and the mailbox", () => {
	it("stops the mailbox, then P2P, before recording the new active vault", async () => {
		await desktopShell.setActiveVault?.("vault-b");
		expect(h.order).toEqual(["mailbox:vault-b", "p2p:vault-b", "record:active-vault=vault-b"]);
	});

	it("does the same when no vault is active", async () => {
		await desktopShell.setActiveVault?.(null);
		expect(h.order).toEqual(["mailbox:null", "p2p:null", "remove:active-vault"]);
	});

	it("asks the mailbox for a round and for its members", async () => {
		expect(await desktopShell.mailboxSyncNow?.()).toBe("synced");
		expect(await desktopShell.mailboxMembers?.()).toEqual([
			{ sigKey: "K", status: "active", lastCheckedDay: 1 },
		]);
	});
});
