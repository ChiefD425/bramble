import { describe, expect, it } from "vitest";
import type { EntriesPayload } from "../sync/entries-payload";
import type { Hlc } from "../sync/hlc";
import type { EncryptedEntry } from "../vault-format";
import type { EntriesBlobStore } from "./entries-blob";
import { appendQuarantine, type QuarantinedEntry, quarantineEntries } from "./quarantine";
import { withVaultWriteLock } from "./write-lock";

const hlc = (wall: number, node = "n"): Hlc => ({ wall, counter: 0, node });
const env = (id: string, wall = 1): EncryptedEntry => ({
	id,
	wrappedDek: "w",
	dekIv: "d",
	ciphertext: id,
	iv: "i",
	hlc: hlc(wall),
});

function fakes(initial: EntriesPayload) {
	let quarantine: string | null = null;
	let disk = initial;
	const storage = {
		readQuarantine: async () => quarantine,
		writeQuarantine: async (json: string) => {
			quarantine = json;
		},
	};
	const store: EntriesBlobStore = {
		readEntriesPayload: async () => disk,
		writeEntriesBlob: async (p) => {
			disk = p;
		},
	};
	return {
		storage,
		store,
		disk: () => disk,
		setDisk: (p: EntriesPayload) => {
			disk = p;
		},
		kept: () => (quarantine === null ? [] : (JSON.parse(quarantine) as QuarantinedEntry[])),
		setRaw: (raw: string) => {
			quarantine = raw;
		},
	};
}

describe("quarantineEntries", () => {
	it("moves unreadable entries out of the vault and keeps them sealed", async () => {
		const f = fakes({ entries: [env("mine"), env("stray")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1000 }, [
			env("stray"),
		]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["mine"]);
		expect(f.kept()).toEqual([{ ...env("stray"), quarantinedAt: 1000 }]);
	});

	it("can empty a vault that held only stray entries", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [
			env("stray"),
		]);
		expect(f.disk().entries).toEqual([]);
		expect(f.kept()).toHaveLength(1);
	});

	it("keeps entries a merge added since the load", async () => {
		const f = fakes({ entries: [env("mine"), env("stray")], tombstones: [] });
		f.setDisk({ entries: [env("mine"), env("stray"), env("fromPeer")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [
			env("stray"),
		]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["mine", "fromPeer"]);
	});

	it("only removes the exact version it found unreadable", async () => {
		const f = fakes({ entries: [env("x", 2)], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [
			env("x", 1),
		]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["x"]);
	});

	it("does not store the same version twice, and never drops what it kept", async () => {
		const f = fakes({ entries: [env("a"), env("b")], tombstones: [] });
		const deps = { storage: f.storage, store: f.store, vaultId: "v", now: 1 };
		await quarantineEntries(deps, [env("a")]);
		await quarantineEntries(deps, [env("a"), env("b")]);
		expect(f.kept().map((q) => q.id)).toEqual(["a", "b"]);
	});

	it("stores before rewriting, so a failed rewrite loses nothing", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		const store: EntriesBlobStore = {
			...f.store,
			writeEntriesBlob: async () => {
				throw new Error("disk full");
			},
		};
		await expect(
			quarantineEntries({ storage: f.storage, store, vaultId: "v", now: 1 }, [env("stray")]),
		).rejects.toThrow();
		expect(f.kept()).toHaveLength(1);
	});

	it.each(["{not json", '{"an":"object"}'])(
		"keeps a store it can't read (%s) inside the new one, and still opens",
		async (raw) => {
			const f = fakes({ entries: [env("stray")], tombstones: [] });
			f.setRaw(raw);
			await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 5 }, [
				env("stray"),
			]);
			expect(f.disk().entries).toEqual([]);
			expect(f.kept()).toEqual([
				{ unreadableStore: raw, quarantinedAt: 5 },
				{ ...env("stray"), quarantinedAt: 5 },
			]);
		},
	);

	it("carries records it doesn't recognise forward untouched", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		f.setRaw('[1,"x",null]');
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 5 }, [
			env("stray"),
		]);
		expect(f.disk().entries).toEqual([]);
		expect(f.kept()).toEqual([1, "x", null, { ...env("stray"), quarantinedAt: 5 }]);
	});
});

describe("appendQuarantine", () => {
	const message = (messageId: string) => ({
		mailboxMessage: "Ym9keQ==",
		mailboxId: "M".repeat(43),
		messageId,
		sender: "S",
		reason: "unopenable" as const,
	});

	it("appends refused entries without rewriting the vault", async () => {
		const f = fakes({ entries: [env("kept")], tombstones: [] });
		await appendQuarantine({ storage: f.storage, vaultId: "v", now: 7 }, { entries: [env("x")] });
		expect(f.kept()).toEqual([{ ...env("x"), quarantinedAt: 7 }]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["kept"]);
	});

	it("keeps a whole message with its reason, once per message id", async () => {
		const f = fakes({ entries: [], tombstones: [] });
		const deps = { storage: f.storage, vaultId: "v", now: 9 };
		await appendQuarantine(deps, { messages: [message("I".repeat(22))] });
		await appendQuarantine(deps, { messages: [message("I".repeat(22))] });
		expect(f.kept()).toEqual([{ ...message("I".repeat(22)), quarantinedAt: 9 }]);
	});

	it("carries an unreadable store forward when appending", async () => {
		const f = fakes({ entries: [], tombstones: [] });
		f.setRaw("not json");
		await appendQuarantine({ storage: f.storage, vaultId: "v", now: 3 }, { entries: [env("x")] });
		expect(f.kept()).toEqual([
			{ unreadableStore: "not json", quarantinedAt: 3 },
			{ ...env("x"), quarantinedAt: 3 },
		]);
	});
});

describe("setting aside under the vault write lock", () => {
	/** Holds the first call until released, and says when it got there. */
	function hold() {
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let arrive = () => {};
		const reached = new Promise<void>((resolve) => {
			arrive = resolve;
		});
		let first = true;
		const wait = async () => {
			if (!first) return;
			first = false;
			arrive();
			await released;
		};
		return { reached, release, wait };
	}
	const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

	it("a save landing while the vault is rewritten is kept", async () => {
		const f = fakes({ entries: [env("mine"), env("stray")], tombstones: [] });
		const gate = hold();
		const store: EntriesBlobStore = {
			...f.store,
			readEntriesPayload: async () => {
				const payload = f.disk();
				await gate.wait();
				return payload;
			},
		};
		const setting = quarantineEntries({ storage: f.storage, store, vaultId: "v", now: 1 }, [
			env("stray"),
		]);
		await gate.reached;
		const saving = withVaultWriteLock(async () => {
			f.setDisk({ ...f.disk(), entries: [...f.disk().entries, env("saved")] });
		});
		await tick();
		gate.release();
		await Promise.all([setting, saving]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["mine", "saved"]);
	});

	it("a record added while entries are being set aside is kept", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		const gate = hold();
		const storage = {
			...f.storage,
			readQuarantine: async () => {
				const raw = await f.storage.readQuarantine();
				await gate.wait();
				return raw;
			},
		};
		const setting = quarantineEntries({ storage, store: f.store, vaultId: "v", now: 1 }, [
			env("stray"),
		]);
		await gate.reached;
		const appending = appendQuarantine(
			{ storage, vaultId: "v", now: 1 },
			{ entries: [env("refused")] },
		);
		await tick();
		gate.release();
		await Promise.all([setting, appending]);
		expect(f.kept().map((q) => q.id)).toEqual(["stray", "refused"]);
	});
});
