import { describe, expect, it } from "vitest";
import type { BreachResult, BreachStatus, Entry, LoginEntry } from "../hooks/useVault";
import { BREACH_RECHECK_MS } from "../util/pwned";
import {
	type BreachSweep,
	dueForBreachCheck,
	newBreachSweep,
	SWEEP_CONCURRENCY,
	SWEEP_SAVE_EVERY,
	sweepBreaches,
} from "./breach-sweep";

const NOW = 100 * BREACH_RECHECK_MS;

const login = (id: string, over: Partial<LoginEntry> = {}): LoginEntry => ({
	id,
	type: "login",
	name: id,
	urls: [],
	username: "u",
	password: `pw-${id}`,
	...over,
});

const logins = (n: number) => Array.from({ length: n }, (_, i) => login(`l${i}`));

/** A vault the sweep reads and writes, with a check that answers on demand. */
function fakeVault(
	entries: Entry[],
	check?: (password: string) => Promise<BreachStatus | undefined>,
) {
	const vault = { entries, saves: [] as BreachResult[][], checked: [] as string[] };
	let inFlight = 0;
	let maxInFlight = 0;
	const deps = {
		due: () => dueForBreachCheck(vault.entries, NOW),
		check: async (password: string) => {
			vault.checked.push(password);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				// Yields like a request would, so checks started together overlap.
				await new Promise((r) => setTimeout(r, 0));
				return check ? await check(password) : { leaked: password.endsWith("bad"), checkedAt: NOW };
			} finally {
				inFlight -= 1;
			}
		},
		save: async (results: BreachResult[]) => {
			vault.saves.push(results);
			const byId = new Map(results.map((r) => [r.id, r.breach]));
			vault.entries = vault.entries.map((e) =>
				byId.has(e.id) ? ({ ...e, breach: byId.get(e.id) } as Entry) : e,
			);
		},
	};
	return { vault, deps, maxInFlight: () => maxInFlight };
}

describe("dueForBreachCheck", () => {
	it("picks live logins with a password and no recent result", () => {
		const entries: Entry[] = [
			login("never"),
			login("stale", { breach: { leaked: false, checkedAt: NOW - BREACH_RECHECK_MS - 1 } }),
			login("fresh", { breach: { leaked: false, checkedAt: NOW - 1000 } }),
			login("archived", { archivedAt: 1 }),
			login("blank", { password: "" }),
			{ id: "n", type: "note", name: "n" },
		];
		expect(dueForBreachCheck(entries, NOW).map((e) => e.id)).toEqual(["never", "stale"]);
	});
});

describe("sweepBreaches", () => {
	it("checks every due login and saves the results", async () => {
		const { vault, deps } = fakeVault([login("a"), login("bad")]);
		const sweep = newBreachSweep();
		await sweepBreaches(sweep, deps);
		expect(vault.entries.map((e) => (e as LoginEntry).breach)).toEqual([
			{ leaked: false, checkedAt: NOW },
			{ leaked: true, checkedAt: NOW },
		]);
		expect(sweep).toMatchObject({ running: false, halted: false });
	});

	it("keeps a few checks in flight at once, not one per login", async () => {
		const f = fakeVault(logins(SWEEP_CONCURRENCY * 3));
		await sweepBreaches(newBreachSweep(), f.deps);
		expect(f.vault.checked).toHaveLength(SWEEP_CONCURRENCY * 3);
		expect(f.maxInFlight()).toBe(SWEEP_CONCURRENCY);
	});

	it("saves in batches rather than once per check", async () => {
		const f = fakeVault(logins(SWEEP_SAVE_EVERY * 2 + 3));
		await sweepBreaches(newBreachSweep(), f.deps);
		expect(f.vault.saves.map((s) => s.length)).toEqual([SWEEP_SAVE_EVERY, SWEEP_SAVE_EVERY, 3]);
	});

	// Offline, every remaining check would wait out its timeout. What was checked is kept.
	it("stops at the first failed check, saves what it has, and stays stopped", async () => {
		const f = fakeVault(logins(10), async (pw) =>
			pw === "pw-l5" ? undefined : { leaked: false, checkedAt: NOW },
		);
		const sweep = newBreachSweep();
		await sweepBreaches(sweep, f.deps);
		expect(sweep.halted).toBe(true);
		expect(f.vault.checked).toHaveLength(8);
		expect(f.vault.saves.flat().map((r) => r.id)).toEqual([
			"l0",
			"l1",
			"l2",
			"l3",
			"l4",
			"l6",
			"l7",
		]);
		await sweepBreaches(sweep, f.deps);
		expect(f.vault.checked).toHaveLength(8);
	});

	it("halts when a save fails", async () => {
		const f = fakeVault(logins(2));
		f.deps.save = async () => {
			throw new Error("the open vault has not finished loading");
		};
		const sweep = newBreachSweep();
		await sweepBreaches(sweep, f.deps);
		expect(sweep).toMatchObject({ running: false, halted: true });
	});

	// Locked mid-check: the vault can't take the write, and the results belong to the last session.
	it("saves nothing once cancelled", async () => {
		let sweep: BreachSweep = newBreachSweep();
		const f = fakeVault(logins(3), async () => {
			sweep.cancelled = true;
			return { leaked: false, checkedAt: NOW };
		});
		sweep = newBreachSweep();
		await sweepBreaches(sweep, f.deps);
		expect(f.vault.checked).toHaveLength(3);
		expect(f.vault.saves).toEqual([]);
	});

	// A result the vault refused (the password changed meanwhile) leaves the login due; without
	// the tried set the pass would check it forever.
	it("tries each login once per session", async () => {
		const f = fakeVault([login("a")]);
		f.deps.save = async () => {};
		const sweep = newBreachSweep();
		await sweepBreaches(sweep, f.deps);
		await sweepBreaches(sweep, f.deps);
		expect(f.vault.checked).toEqual(["pw-a"]);
	});

	it("picks up a login added while the pass runs", async () => {
		let added = false;
		const f = fakeVault([login("a")], async () => {
			if (!added) {
				added = true;
				f.vault.entries = [...f.vault.entries, login("b")];
			}
			return { leaked: false, checkedAt: NOW };
		});
		await sweepBreaches(newBreachSweep(), f.deps);
		expect(f.vault.checked).toEqual(["pw-a", "pw-b"]);
	});

	// The pass is out of checks but still saving: a login arriving then must not wait for the
	// next unlock.
	it("picks up a login that arrives during the last save", async () => {
		const f = fakeVault([login("a")]);
		const save = f.deps.save;
		let added = false;
		f.deps.save = async (results) => {
			await save(results);
			if (!added) {
				added = true;
				f.vault.entries = [...f.vault.entries, login("b")];
			}
		};
		await sweepBreaches(newBreachSweep(), f.deps);
		expect(f.vault.checked).toEqual(["pw-a", "pw-b"]);
	});

	it("does not start a second pass while one runs", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const f = fakeVault([login("a")], async () => {
			await gate;
			return { leaked: false, checkedAt: NOW };
		});
		const sweep = newBreachSweep();
		const first = sweepBreaches(sweep, f.deps);
		await sweepBreaches(sweep, f.deps);
		release();
		await first;
		expect(f.vault.checked).toEqual(["pw-a"]);
	});
});
