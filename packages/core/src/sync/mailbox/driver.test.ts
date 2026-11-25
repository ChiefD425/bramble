import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxApiError, type MailboxServer } from "./api";
import type { MailboxConfig, MailboxStatusRecord } from "./config";
import { createMailboxDriver, type MailboxDriverDeps, type MailboxEngine } from "./driver";
import { accountKeyOf } from "./protocol";

const CUSTOM: MailboxConfig = { kind: "custom", url: "https://mailbox.example" };

function setup(
	over: {
		config?: MailboxConfig | null;
		off?: boolean;
		status?: string;
		account?: string;
		hosted?: boolean;
		keyHome?: MailboxDriverDeps["keyHome"];
	} = {},
) {
	const state = {
		config: over.config === undefined ? CUSTOM : over.config,
		account: over.account ?? null,
		off: over.off ?? false,
		identity: "G1|K" as string | null,
	};
	const clock = { now: 1000 };
	const records: MailboxStatusRecord[] = [];
	const calls: string[] = [];
	const sync = {
		sync: vi.fn(async () => over.status ?? "synced"),
		switchOff: vi.fn(async () => {}),
	};
	const members = [{ sigKey: "K", status: "active", lastCheckedDay: 20_000 }];
	const api = {
		members: vi.fn(async () => ({ members })),
		accountStatus: vi.fn(async (): Promise<unknown> => {
			throw new Error("no account status set up");
		}),
	};
	const statuses: [string, MailboxStatusRecord["status"]][] = [];
	const alarms = { create: vi.fn(), clear: vi.fn() };
	const deps: MailboxDriverDeps = {
		build: vi.fn(
			async (_vaultId: string, server: MailboxServer) =>
				({
					sync: {
						sync: async () => {
							calls.push(`sync:${server.url}`);
							return sync.sync();
						},
						switchOff: () => sync.switchOff(),
					},
					api,
				}) as unknown as MailboxEngine,
		),
		identity: async () => state.identity,
		readSettings: async () => ({ config: state.config, account: state.account }),
		offHere: async () => state.off,
		writeStatus: async (vaultId, record) => {
			statuses.push([vaultId, record.status]);
			records.push(record);
		},
		alarms,
		keepAlive: (run) => run(),
		now: () => clock.now,
		hosted: over.hosted ?? false,
		...(over.keyHome ? { keyHome: over.keyHome } : {}),
	};
	return { deps, state, sync, api, statuses, records, clock, alarms, members, calls };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the mailbox driver", () => {
	it("runs a round when a vault opens with the mailbox on, and records its status", async () => {
		const s = setup();
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "synced"]]));
		expect(s.deps.build).toHaveBeenCalledWith("v1", { url: CUSTOM.url }, expect.any(Function));
	});

	it("records off and builds nothing when the group has no mailbox", async () => {
		const s = setup({ config: null });
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "off"]]));
		expect(s.deps.build).not.toHaveBeenCalled();
	});

	it("treats a hosted mailbox as off while hosted is off", async () => {
		const s = setup({ config: { kind: "hosted" } });
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "off"]]));
		expect(s.deps.build).not.toHaveBeenCalled();
	});

	it("debounces local changes into one round", async () => {
		vi.useFakeTimers();
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.advanceTimersByTimeAsync(0);
		expect(s.sync.sync).toHaveBeenCalledTimes(1);
		driver.changed();
		driver.changed();
		await vi.advanceTimersByTimeAsync(2000);
		driver.changed();
		await vi.advanceTimersByTimeAsync(2999);
		expect(s.sync.sync).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(s.sync.sync).toHaveBeenCalledTimes(2);
	});

	it("an alarm takes in a change still waiting for its quiet window", async () => {
		vi.useFakeTimers();
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.advanceTimersByTimeAsync(0);
		driver.changed();
		await driver.alarm();
		expect(s.sync.sync).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(s.sync.sync).toHaveBeenCalledTimes(2);
	});

	it("rebuilds the engine when the server changes", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		s.state.config = { kind: "custom", url: "https://other.example" };
		await driver.syncNow();
		expect(s.deps.build).toHaveBeenCalledTimes(2);
		expect(s.deps.build).toHaveBeenLastCalledWith(
			"v1",
			{ url: "https://other.example" },
			expect.any(Function),
		);
	});

	it("leaving the group switches this device off in the old mailbox, once", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		const before = s.calls.length;
		s.state.identity = null;
		await driver.syncNow();
		await driver.syncNow();
		expect(s.sync.switchOff).toHaveBeenCalledTimes(1);
		expect(s.calls.slice(before)).toEqual([]);
	});

	it("joining another group switches off in the old mailbox before the new one runs", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		s.state.identity = "G2|K";
		await driver.syncNow();
		expect(s.sync.switchOff).toHaveBeenCalledTimes(1);
		expect(s.deps.build).toHaveBeenCalledTimes(2);
	});

	it("a failed switch-off on leaving doesn't run the old engine", async () => {
		const s = setup();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		s.sync.switchOff.mockRejectedValue(new Error("offline"));
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		const before = s.calls.length;
		s.state.identity = null;
		await driver.syncNow();
		await driver.syncNow();
		expect(warn).toHaveBeenCalled();
		expect(s.sync.switchOff).toHaveBeenCalledTimes(1);
		expect(s.calls.slice(before)).toEqual([]);
		warn.mockRestore();
	});

	it("switches off once when this device opts out, and stays quiet", async () => {
		const s = setup({ off: true });
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		await driver.syncNow();
		expect(s.sync.switchOff).toHaveBeenCalledTimes(1);
		expect(s.sync.sync).not.toHaveBeenCalled();
		expect(s.statuses.map(([, status]) => status)).toEqual(["off", "off"]);
		s.state.off = false;
		expect(await driver.syncNow()).toBe("synced");
	});

	it("is no longer current after a lock or a switch", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		expect(driver.current("v1")).toBe(true);
		driver.retarget("v2");
		expect(driver.current("v1")).toBe(false);
		driver.retarget(null);
		expect(driver.current("v2")).toBe(false);
		await driver.alarm();
		await new Promise((r) => setTimeout(r, 20));
		// The round v1 started never judged anything once v1 stopped being current.
		expect(s.sync.sync).not.toHaveBeenCalled();
		expect(s.statuses).toEqual([]);
	});

	it("a failed round waits for the alarm", async () => {
		const s = setup({ status: "retry" });
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "retry"]]));
		await new Promise((r) => setTimeout(r, 20));
		expect(s.sync.sync).toHaveBeenCalledTimes(1);
		await driver.alarm();
		expect(s.sync.sync).toHaveBeenCalledTimes(2);
	});

	it("resumes on wake without a second activation", async () => {
		const s = setup();
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(2));
		expect(s.deps.build).toHaveBeenCalledTimes(2);
		expect(s.sync.sync).toHaveBeenCalledTimes(2);
	});

	it("creates the alarm while running and clears it when off", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.alarms.create).toHaveBeenCalledWith("mailbox:sync", 5));
		s.state.config = null;
		await driver.syncNow();
		expect(s.alarms.clear).toHaveBeenCalledWith("mailbox:sync");
	});

	it("answers the members from the engine, or null with none", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		expect(await driver.members()).toBeNull();
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		expect(await driver.members()).toEqual(s.members);
	});

	it("drops the engine and waits when the vault leaves its group", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		s.state.identity = null;
		expect(await driver.syncNow()).toBe("waiting");
		// No round on the old group's engine: it would prune the members with an empty roster.
		expect(s.calls).toEqual(["sync:https://mailbox.example"]);
		expect(s.alarms.clear).toHaveBeenCalledWith("mailbox:sync");
		expect(await driver.members()).toBeNull();
	});

	it("rebuilds without a last round on the old group when the group changes", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		s.state.identity = "G2|K";
		await driver.syncNow();
		expect(s.deps.build).toHaveBeenCalledTimes(2);
		expect(s.calls).toHaveLength(2);
	});

	it("gives the old server one last round before switching to a new one", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		s.state.config = { kind: "custom", url: "https://other.example" };
		await driver.syncNow();
		expect(s.calls).toEqual([
			"sync:https://mailbox.example",
			"sync:https://mailbox.example",
			"sync:https://other.example",
		]);
	});

	it("gives the mailbox one last round when it is stopped", async () => {
		const s = setup();
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toHaveLength(1));
		s.state.config = null;
		expect(await driver.syncNow()).toBe("off");
		expect(s.calls).toEqual(["sync:https://mailbox.example", "sync:https://mailbox.example"]);
	});

	it("an opt-out that cannot reach the server still reads off, without the alarm", async () => {
		const s = setup({ off: true });
		s.sync.switchOff.mockRejectedValueOnce(new Error("offline"));
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "off"]]));
		expect(s.alarms.clear).toHaveBeenCalledWith("mailbox:sync");
		expect(s.alarms.create).not.toHaveBeenCalled();
	});
});

describe("the account behind a hosted mailbox", () => {
	const A = "12345 67890 12345 67890 12345";
	const B = "66666 77777 88888 99999 00000";
	const FIGURES = { paidThrough: 9_000_000, frozen: false, usedBytes: 12, quotaBytes: 1e9 };
	const hosted = () => setup({ config: { kind: "hosted" }, account: A, hosted: true });
	/** A driver on vault v1, past the round that opening it runs. */
	async function opened(s: ReturnType<typeof setup>) {
		const driver = createMailboxDriver(s.deps);
		driver.retarget("v1");
		await vi.waitFor(() => expect(s.records).toHaveLength(1));
		return driver;
	}

	it("records the account's status after a round, at most every 5 minutes", async () => {
		const s = hosted();
		s.api.accountStatus.mockResolvedValue(FIGURES);
		const driver = await opened(s);
		const first = { ...FIGURES, at: s.clock.now, key: await accountKeyOf(A) };
		expect(s.records.at(-1)?.account).toEqual(first);
		s.clock.now += 60_000;
		await driver.syncNow();
		expect(s.api.accountStatus).toHaveBeenCalledTimes(1);
		expect(s.records.at(-1)?.account).toEqual(first);
		s.clock.now += 6 * 60_000;
		await driver.syncNow();
		expect(s.api.accountStatus).toHaveBeenCalledTimes(2);
		expect(s.records.at(-1)?.account).toEqual({
			...FIGURES,
			at: s.clock.now,
			key: await accountKeyOf(A),
		});
	});

	it("a changed number is checked at once, and the old one's record is dropped", async () => {
		const s = hosted();
		s.api.accountStatus.mockResolvedValueOnce(FIGURES);
		const driver = await opened(s);
		s.state.account = B;
		s.api.accountStatus.mockRejectedValueOnce(new Error("offline"));
		s.clock.now += 1000;
		await driver.syncNow();
		expect(s.api.accountStatus).toHaveBeenCalledTimes(2);
		expect(s.records.at(-1)?.account).toBeUndefined();
	});

	it("a failed check keeps the last record", async () => {
		const s = hosted();
		s.api.accountStatus.mockResolvedValueOnce(FIGURES);
		const driver = await opened(s);
		const first = { ...FIGURES, at: s.clock.now, key: await accountKeyOf(A) };
		s.api.accountStatus.mockRejectedValueOnce(new Error("offline"));
		s.clock.now += 6 * 60_000;
		await driver.syncNow();
		expect(s.api.accountStatus).toHaveBeenCalledTimes(2);
		expect(s.records.at(-1)?.account).toEqual(first);
	});

	it("an unknown number is recorded as unknown", async () => {
		const s = hosted();
		s.api.accountStatus.mockRejectedValue(new MailboxApiError(403, "account_unknown"));
		await opened(s);
		expect(s.records.at(-1)?.account).toEqual({
			unknown: true,
			at: s.clock.now,
			key: await accountKeyOf(A),
		});
	});

	it("a group with no number records no account", async () => {
		const s = setup({ config: { kind: "hosted" }, hosted: true });
		await opened(s);
		expect(s.api.accountStatus).not.toHaveBeenCalled();
		expect(s.records.at(-1)).not.toHaveProperty("account");
	});
});

describe("one mailbox per device-wide key", () => {
	/** A key claim held in memory: `vault` is the vault the key is active for, or null. */
	const home = (vault: string | null) => {
		const held = { vault };
		const keyHome = {
			claim: vi.fn(async (v: string) => {
				if (held.vault && held.vault !== v) return false;
				held.vault = v;
				return true;
			}),
			release: vi.fn(async (v: string) => {
				if (held.vault === v) held.vault = null;
			}),
		};
		return { held, keyHome };
	};

	it("a vault claims the key and runs", async () => {
		const { held, keyHome } = home(null);
		const s = setup({ keyHome });
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "synced"]]));
		expect(held.vault).toBe("v1");
	});

	it("a second vault waits while the key is active for the first", async () => {
		const { keyHome } = home("v0");
		const s = setup({ keyHome });
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "other_vault"]]));
		expect(s.deps.build).not.toHaveBeenCalled();
	});

	it("switching the first off lets the second in", async () => {
		const { held, keyHome } = home("v1");
		const s = setup({ keyHome, off: true });
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "off"]]));
		expect(held.vault).toBeNull();
	});

	it("stopping the mailbox for the first vault's group lets the second in", async () => {
		const { held, keyHome } = home("v1");
		const s = setup({ keyHome, config: null });
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "off"]]));
		expect(held.vault).toBeNull();
	});

	it("the first vault leaving its group lets the second in", async () => {
		const { held, keyHome } = home("v1");
		const s = setup({ keyHome });
		s.state.identity = null;
		createMailboxDriver(s.deps).retarget("v1");
		await vi.waitFor(() => expect(s.statuses).toEqual([["v1", "waiting"]]));
		expect(held.vault).toBeNull();
	});
});
