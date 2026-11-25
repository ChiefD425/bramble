// Merging a device's closed deltas, in any order, reaches the same state as merging its whole
// final state (docs/mailbox-service.md, "Messages"). Two devices make real edits, attachments and
// settings changes and merge each other now and then; one of them cuts deltas as it goes.

import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../../hooks/useVault";
import { type VaultEntries, vaultEntriesFromPayload } from "../../vault/entry-mutations";
import { harness } from "../../vault/entry-mutations.harness";
import { createFileMutations, type FileSealer } from "../../vault/file-mutations";
import { applyRemotePayload, createVaultSyncPort, payloadsEquivalent } from "../apply-remote";
import { type EntriesPayload, emptyEntriesPayload } from "../entries-payload";
import { liveFiles, mergeEntriesPayload } from "../vault-merge";
import { cutDelta, type PostedIndex } from "./delta";

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function sealer(): FileSealer {
	let seq = 0;
	return {
		seal: async () => ({
			hash: (++seq).toString(16).padStart(64, "0"),
			size: 32,
			wrappedFek: "wf",
			fekIv: "fi",
			noncePrefix: "np",
			metaBlob: "mb",
			metaIv: "mi",
		}),
		resealMeta: async () => ({ metaBlob: "mb2", metaIv: "mi2" }),
		describe: async () => ({ name: "f", mime: "application/pdf", plaintextSize: 16 }),
	};
}

function device(now: () => number, node: string) {
	const h = harness(now, node);
	const files = createFileMutations({
		sealer: sealer(),
		persist: h.mutations.persist,
		clock: async () => h.clock,
	});
	return { ...h, files };
}
type Device = ReturnType<typeof device>;

const login = (name: string): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password: name,
});

async function load(d: Device): Promise<VaultEntries> {
	const payload = await d.mutations.readEntriesPayload();
	const decrypted = payload.entries.map(
		(e) => ({ id: e.id, ...JSON.parse(e.ciphertext.slice(3)) }) as Entry,
	);
	return vaultEntriesFromPayload(payload, decrypted);
}

async function merge(from: Device, to: Device): Promise<void> {
	const port = createVaultSyncPort({
		store: to.mutations,
		crypto: to.crypto,
		witnessRemote: async (stamps) => {
			for (const s of stamps) to.clock.witness(s);
		},
	});
	await applyRemotePayload(port, await from.mutations.readEntriesPayload(), { combine: false });
}

async function step(d: Device, other: Device, rand: () => number, k: number): Promise<void> {
	const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
	const current = await load(d);
	const live = current.entries.map((e) => e.id);
	const op = Math.floor(rand() * 7);
	const id = pick(live);
	if (op === 0 || id === undefined) await d.mutations.add(current, login(`n${k}`));
	else if (op === 1) await d.mutations.update(current, id, login(`e${k}`));
	else if (op === 2) await d.mutations.remove(current, id);
	else if (op === 3)
		await d.mutations.setSetting(
			current,
			pick(["theme", "lang"]) as string,
			pick(["x", "y", null]),
		);
	else if (op === 4)
		await d.files.attach(current, {
			source: { kind: "bytes", bytes: new Uint8Array([k & 255]) },
			name: "f",
			mime: "application/pdf",
			entryId: id,
		});
	else if (op === 5) {
		const file = pick(liveFiles(await d.mutations.readEntriesPayload()));
		if (file) await d.files.detach(current, file.id);
	} else await merge(other, d);
}

function shuffled<T>(xs: T[], rand: () => number): T[] {
	const out = [...xs];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

const SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);
const STEPS = 30;

describe("closed deltas", () => {
	it("merging every delta equals merging the whole final state", async () => {
		let checked = 0;
		for (const seed of SEEDS) {
			const rand = mulberry32(seed);
			const time = { now: 1000 };
			const a = device(() => time.now, "laptop");
			const b = device(() => time.now, "phone");
			const parts: EntriesPayload[] = [];
			let index: PostedIndex = {};
			const cut = async () => {
				const next = await cutDelta(await a.mutations.readEntriesPayload(), index);
				parts.push(...next.parts);
				index = next.index;
			};
			for (let k = 0; k < STEPS; k++) {
				time.now += 1 + Math.floor(rand() * 3);
				if (rand() < 0.6) await step(a, b, rand, k);
				else await step(b, a, rand, k);
				if (rand() < 1 / 3) await cut();
			}
			await cut();
			const final = await a.mutations.readEntriesPayload();
			for (const start of [emptyEntriesPayload(), await b.mutations.readEntriesPayload()]) {
				const folded = shuffled(parts, rand).reduce(mergeEntriesPayload, start);
				if (!payloadsEquivalent(folded, mergeEntriesPayload(start, final))) {
					throw new Error(`seed ${seed}: merging the deltas differs from merging the whole state`);
				}
				checked++;
			}
		}
		expect(checked).toBe(SEEDS.length * 2);
	}, 60_000);
});
