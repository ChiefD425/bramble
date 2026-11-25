import { describe, expect, it } from "vitest";
import { fileRecord } from "../../test/vault-fixtures";
import type { EncryptedEntry } from "../../vault-format";
import type { EntriesPayload } from "../entries-payload";
import type { Hlc } from "../hlc";
import { cutDelta } from "./delta";

const hlc = (wall: number, node = "n"): Hlc => ({ wall, counter: 0, node });
const env = (id: string, wall: number, ct = id): EncryptedEntry => ({
	id,
	wrappedDek: "w",
	dekIv: "d",
	ciphertext: ct,
	iv: "i",
	hlc: hlc(wall),
});
const ids = (p: EntriesPayload) =>
	[...p.entries, ...(p.conflicts ?? []), ...p.tombstones].map((v) => v.id).sort();

/** Entry a: shown, a sibling, and a file with its cascade mark. Entry b alone. Two settings. */
function base(): EntriesPayload {
	return {
		entries: [env("a", 2), env("b", 1)],
		conflicts: [env("a", 1, "a-sibling")],
		tombstones: [],
		files: [fileRecord({ id: "f1", entryId: "a", hlc: hlc(1) })],
		fileCascades: [{ id: "f1", hlc: hlc(1) }],
		settings: { theme: { hlc: hlc(1), value: "dark" }, lang: { hlc: hlc(1), value: "en" } },
	};
}

describe("cutDelta", () => {
	it("an unchanged payload cuts nothing", async () => {
		const first = await cutDelta(base(), {});
		expect(first.parts).toHaveLength(1);
		expect((await cutDelta(base(), first.index)).parts).toEqual([]);
	});

	it("an edit carries the entry's whole history and files", async () => {
		const { index } = await cutDelta(base(), {});
		const { parts } = await cutDelta({ ...base(), entries: [env("a", 3), env("b", 1)] }, index);
		expect(parts).toHaveLength(1);
		const part = parts[0]!;
		expect(part.entries).toEqual([env("a", 3)]);
		expect(part.conflicts).toEqual([env("a", 1, "a-sibling")]);
		expect(part.files?.map((f) => f.id)).toEqual(["f1"]);
		expect(part.fileCascades?.map((c) => c.id)).toEqual(["f1"]);
		expect(part.settings).toBeUndefined();
		expect(ids(part)).not.toContain("b");
	});

	it("a setting change carries only that setting", async () => {
		const { index } = await cutDelta(base(), {});
		const theme = { hlc: hlc(2), value: "light" };
		const { parts } = await cutDelta({ ...base(), settings: { ...base().settings, theme } }, index);
		expect(parts).toEqual([{ entries: [], tombstones: [], settings: { theme } }]);
	});

	it("deleting a file carries its tombstone and its entry's new closure", async () => {
		const { index } = await cutDelta(base(), {});
		const deleted: EntriesPayload = {
			...base(),
			files: [],
			fileTombstones: [{ id: "f1", hlc: hlc(2) }],
		};
		const { parts } = await cutDelta(deleted, index);
		expect(parts).toHaveLength(1);
		expect(parts[0]!.fileTombstones?.map((t) => t.id)).toEqual(["f1"]);
		expect(ids(parts[0]!)).toContain("a");
	});

	it("a tombstone gaining history under the same stamp is a change", async () => {
		const { index } = await cutDelta({ entries: [], tombstones: [{ id: "t", hlc: hlc(5) }] }, {});
		const grown: EntriesPayload = {
			entries: [],
			tombstones: [{ id: "t", hlc: hlc(5), vv: { other: hlc(4, "other") } }],
		};
		expect((await cutDelta(grown, index)).parts).toHaveLength(1);
	});

	it("packs groups into closed parts under the budget", async () => {
		const five: EntriesPayload = {
			entries: ["p", "q", "r", "s", "t"].map((id, i) => env(id, i + 2, "x".repeat(400))),
			conflicts: [env("p", 1, "y".repeat(400))],
			tombstones: [],
		};
		const { parts } = await cutDelta(five, {}, 2000);
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			expect(new TextEncoder().encode(JSON.stringify(part)).length).toBeLessThanOrEqual(2000);
		}
		expect(parts.flatMap(ids).sort()).toEqual(["p", "p", "q", "r", "s", "t"]);
		expect(parts.filter((part) => ids(part).includes("p"))).toHaveLength(1);
	});

	it("a group over the budget throws", async () => {
		const big: EntriesPayload = { entries: [env("big", 1, "x".repeat(5000))], tombstones: [] };
		await expect(cutDelta(big, {}, 2000)).rejects.toThrow("larger than a mailbox message");
	});
});
