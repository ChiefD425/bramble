import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VAULT_REGISTRY_KEY } from "../../vault/vault-registry";
import { mailboxStatusKey } from "./config";
import { createInProcessMailbox, deviceKeyHome, type InProcessMailboxPlatform } from "./in-process";

// The mailbox as mobile and desktop run it: what starts and stops a round, and which vault a
// round may still judge messages for. The driver is the real one; the engine is a fake, and the
// platform is a plain object standing in for the app's own pieces.

interface VaultPortDeps {
	current(): boolean;
	vaultId: string;
}

const h = vi.hoisted(() => ({
	rounds: [] as string[],
	switchedOff: 0,
	/** Held open by a test to act mid-round. */
	gate: null as Promise<void> | null,
	built: [] as { vault: VaultPortDeps & { apply(r: unknown): Promise<unknown> }; mover: unknown }[],
	applied: [] as string[],
}));

vi.mock("./api", async (importOriginal) => ({
	...(await importOriginal<typeof import("./api")>()),
	mailboxApi: () => ({
		members: async () => ({ members: [{ sigKey: "K", status: "active", lastCheckedDay: 1 }] }),
	}),
}));
vi.mock("./vault-port", () => ({
	createMailboxVaultPort: (deps: VaultPortDeps) => ({
		...deps,
		apply: async () => {
			h.applied.push(deps.vaultId);
			return null;
		},
	}),
}));
vi.mock("./sync", () => ({
	mailboxSync: (opts: {
		vault: VaultPortDeps & { apply(r: unknown): Promise<unknown> };
		blobs: { mover: unknown };
	}) => {
		h.built.push({ vault: opts.vault, mover: opts.blobs.mover });
		return {
			sync: async () => {
				h.rounds.push(opts.vault.vaultId);
				if (h.gate) await h.gate;
				return "synced";
			},
			switchOff: async () => {
				h.switchedOff++;
			},
		};
	},
}));

const A = "vault-a";
const B = "vault-b";
const SERVER = { kind: "custom", url: "https://mailbox.example" };

function fakePlatform() {
	const meta = new Map<string, unknown>();
	const subs = new Map<string, () => void>();
	const cues = {
		state: null as ((locked: boolean) => void) | null,
		written: null as ((vaultId: string) => void) | null,
		tick: null as (() => void) | null,
		wake: null as (() => void) | null,
	};
	const queued: string[] = [];
	const platform: InProcessMailboxPlatform & { active: string | undefined } = {
		active: A,
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => {
				meta.set(k, v);
			},
			subscribeMeta: (k: string, cb: () => void) => {
				subs.set(k, cb);
				return () => subs.delete(k);
			},
			readQuarantine: async () => null,
			writeQuarantine: async () => {},
		} as unknown as InProcessMailboxPlatform["storage"],
		crypto: {
			mailboxId: async () => "M".repeat(43),
			mailboxSeal: async () => "",
			mailboxOpen: async () => "",
		} as unknown as InProcessMailboxPlatform["crypto"],
		http: { send: async () => ({ status: 200, ok: true, body: new Uint8Array() }) },
		sigKey: async () => "K",
		sign: async () => "sig",
		verify: async () => true,
		group: async (vaultId) => meta.get(`sync.group:${vaultId}`) as { groupKey: string } | undefined,
		vaultDeps: (vaultId) =>
			({
				readEntries: async () => ({
					entries: [],
					tombstones: [],
					settings: meta.get(`config:${vaultId}`)
						? { "pref.mailbox": { value: meta.get(`config:${vaultId}`) } }
						: {},
				}),
			}) as unknown as ReturnType<InProcessMailboxPlatform["vaultDeps"]>,
		refusedFor: () => new Set(),
		queueApply: async (apply) => {
			queued.push("queued");
			return apply();
		},
		blobs: () => ({ store: {} as never, mover: "the platform's mover" as never }),
		activeVaultId: async () => platform.active,
		onVaultStateChange: (cb) => {
			cues.state = cb;
			return () => {};
		},
		onVaultWritten: (cb) => {
			cues.written = cb;
			return () => {};
		},
		onTick: (cb) => {
			cues.tick = cb;
			return () => {};
		},
		onWake: (cb) => {
			cues.wake = cb;
			return () => {};
		},
		hosted: false,
	};
	/** Vault `id` in a group, with a mailbox configured. */
	const ready = (id: string, config: unknown = SERVER) => {
		meta.set(`sync.group:${id}`, { groupKey: "G", roster: { devices: [], revoked: [] } });
		meta.set(`config:${id}`, config);
	};
	const status = (id: string) => (meta.get(mailboxStatusKey(id)) as { status?: string })?.status;
	return { platform, meta, subs, cues, queued, ready, status };
}

function setup() {
	const fake = fakePlatform();
	const mailbox = createInProcessMailbox(fake.platform);
	mailbox.init();
	return { ...fake, mailbox, driver: mailbox.driver };
}

beforeEach(() => {
	vi.useFakeTimers();
	h.rounds.length = 0;
	h.switchedOff = 0;
	h.gate = null;
	h.built.length = 0;
	h.applied.length = 0;
});
afterEach(() => vi.useRealTimers());

/** Hold the next round open until the returned release is called. */
function holdRound(): () => void {
	let release!: () => void;
	h.gate = new Promise<void>((r) => {
		release = r;
	});
	return () => {
		h.gate = null;
		release();
	};
}

describe("the in-process mailbox", () => {
	it("unlock runs a round for the active vault; lock stops it", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(t.status(A)).toBe("synced"));
		expect(h.rounds).toEqual([A]);

		t.cues.state?.(true);
		expect(t.driver.current(A)).toBe(false);
		t.cues.tick?.();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.rounds).toEqual([A]);
	});

	it("a lock mid-round leaves the vault no longer current, so nothing more is acknowledged", async () => {
		const t = setup();
		t.ready(A);
		const release = holdRound();
		t.cues.state?.(false);
		await vi.waitFor(() => expect(h.rounds).toEqual([A]));
		expect(h.built[0]?.vault.current()).toBe(true);
		t.cues.state?.(true);
		expect(h.built[0]?.vault.current()).toBe(false);
		release();
	});

	it("switching vault mid-round makes the old vault not current; re-reporting it changes nothing", async () => {
		const t = setup();
		t.ready(A);
		const release = holdRound();
		t.cues.state?.(false);
		await vi.waitFor(() => expect(h.rounds).toEqual([A]));
		t.mailbox.vaultSwitching(A);
		expect(h.built[0]?.vault.current()).toBe(true);
		t.mailbox.vaultSwitching(B);
		expect(h.built[0]?.vault.current()).toBe(false);
		release();
	});

	it("mailbox merges go through the platform's merge queue", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(h.built).toHaveLength(1));
		await h.built[0]?.vault.apply({});
		expect(t.queued).toEqual(["queued"]);
		expect(h.applied).toEqual([A]);
	});

	it("a wake, a tick and a vault write together run one round, not a burst", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(h.rounds).toHaveLength(1));
		t.cues.wake?.();
		t.cues.written?.(A);
		t.cues.tick?.();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.rounds).toHaveLength(2);
	});

	it("a tick runs a round at once while the mailbox is on, with no webview timer in between", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(h.rounds).toHaveLength(1));
		t.cues.tick?.();
		// Microtasks only: a hidden window's timers are throttled, so the tick must not wait on one.
		await vi.advanceTimersByTimeAsync(0);
		expect(h.rounds).toHaveLength(2);
	});

	it("a tick runs nothing while the mailbox is off", async () => {
		const t = setup();
		t.ready(A, null);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(t.status(A)).toBe("off"));
		// Every round writes a fresh status record; an untouched one means no round ran.
		const record = t.meta.get(mailboxStatusKey(A));
		t.cues.tick?.();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(t.meta.get(mailboxStatusKey(A))).toBe(record);
	});

	it("a write to another vault is not this vault's change", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(h.rounds).toHaveLength(1));
		t.cues.written?.(B);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.rounds).toHaveLength(1);
	});

	it("turning this device's mailbox off triggers a round that switches it off", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(t.status(A)).toBe("synced"));
		t.meta.set(`pref.mailboxOff:${A}`, true);
		t.subs.get(`pref.mailboxOff:${A}`)?.();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.switchedOff).toBe(1);
		expect(t.status(A)).toBe("off");
	});

	it("blobs move through the platform's mover", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(h.built).toHaveLength(1));
		expect(h.built[0]?.mover).toBe("the platform's mover");
	});

	it("Sync now answers the round's status, and the members come from the engine's api", async () => {
		const t = setup();
		t.ready(A);
		t.cues.state?.(false);
		await vi.waitFor(() => expect(t.status(A)).toBe("synced"));
		expect(await t.driver.syncNow()).toBe("synced");
		expect(await t.driver.members()).toEqual([
			{ sigKey: "K", status: "active", lastCheckedDay: 1 },
		]);
	});
});

describe("the device-wide key's claim", () => {
	const store = (entries: [string, unknown][]) => {
		const meta = new Map<string, unknown>(entries);
		return {
			meta,
			storage: {
				getMeta: async (k: string) => meta.get(k),
				setMeta: async (k: string, v: unknown) => void meta.set(k, v),
				removeMeta: async (k: string) => void meta.delete(k),
			} as unknown as Parameters<typeof deviceKeyHome>[0],
		};
	};
	const registry = (...ids: string[]) => ({
		vaults: ids.map((id) => ({ id, label: "", createdAt: 1 })),
	});

	it("a claim held by a deleted vault is free", async () => {
		const { meta, storage } = store([
			["mailbox.keyVault", "gone"],
			[VAULT_REGISTRY_KEY, registry("v2")],
		]);
		expect(await deviceKeyHome(storage).claim("v2")).toBe(true);
		expect(meta.get("mailbox.keyVault")).toBe("v2");
	});

	it("a claim held by a vault still here is refused, and released only by it", async () => {
		const { meta, storage } = store([
			["mailbox.keyVault", "v1"],
			[VAULT_REGISTRY_KEY, registry("v1", "v2")],
		]);
		const home = deviceKeyHome(storage);
		expect(await home.claim("v2")).toBe(false);
		await home.release("v2");
		expect(meta.get("mailbox.keyVault")).toBe("v1");
		await home.release("v1");
		expect(await home.claim("v2")).toBe(true);
	});
});
