import { canonicalAdmission, canonicalRosterEntry, type RosterEntry } from "@core/sync/roster";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	enrollOpts: null as { admit?: (entry: RosterEntry) => Promise<RosterEntry> } | null,
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/preferences", () => ({
	Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} },
}));
vi.mock("@core/sync/transport/enroll-host", () => ({
	startEnroll: async (_role: string, opts: typeof h.enrollOpts) => {
		h.enrollOpts = opts;
		return { stop: () => {} };
	},
}));
vi.mock("../adapters/storage", () => ({ mobileStorage: { getMeta: async () => undefined } }));
vi.mock("../adapters/crypto", () => ({ mobileCrypto: {} }));
vi.mock("../adapters/files", () => ({ mobileFiles: {} }));
vi.mock("../adapters/vault-session", () => ({
	notifyExternalChange: () => {},
	onVaultStateChange: () => () => {},
}));
vi.mock("../native-crypto", () => ({
	nativeSyncCrypto: {
		export_vek: async () => "VEK",
		roster_admission_sign: async (_password: string, _salt: string, message: string) =>
			`sig(${message})`,
	},
}));
vi.mock("../secure-storage", () => ({
	secureStorage: {
		get: async () => ({ privateKey: "p", publicKey: "P" }),
		set: async () => {},
		remove: async () => {},
	},
}));
vi.mock("../wasm-loader", () => ({ loadWasm: async () => ({}) }));

// Loaded once, outside any test: compiling this graph is slow under a parallel run, and inside a
// test it counts against that test's timeout.
const { startEnrollInvite } = await import("./sync-manager");

const JOINER: RosterEntry = {
	id: "joiner-id",
	publicKey: "joinerPub",
	label: "Joiner",
	addedAt: 0,
	hlc: { wall: 1000, counter: 0, node: "joiner-id" },
};

async function invite(admission?: { password: string; saltB64: string; adminId: string }) {
	await startEnrollInvite({
		relayUrl: "wss://relay.invalid",
		groupKeyB64: "k",
		psk: "psk",
		roster: { devices: [], revoked: [] },
		entries: { entries: [], tombstones: [] },
		admission,
	});
}

describe("the inviter's admission of a joiner", () => {
	beforeEach(() => {
		h.enrollOpts = null;
	});

	it("is signed by the host, so it can go out with the vault", async () => {
		await invite({ password: "hunter2", saltB64: "SALT", adminId: "inviter-id" });
		const admitted = await h.enrollOpts?.admit?.(JOINER);
		expect(admitted?.admission).toEqual({
			by: "inviter-id",
			sig: `sig(${canonicalRosterEntry(JOINER)})`,
			stableSig: `sig(${canonicalAdmission(JOINER)})`,
		});
	});

	it("isn't offered without the material to sign it", async () => {
		await invite();
		expect(h.enrollOpts?.admit).toBeUndefined();
	});
});
