import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { OpenVaultBackupInput } from "../adapters/crypto";
import { openBackup, VAULT_ENTRY } from "../backup/archive";
import { bytesSource } from "../backup/zip";
import type { FileRecord } from "../sync/entries-payload";
import { memoryBlobStore, sha256Hex } from "../test/memory-blob-store";
import { fileRecord, fill, loginEntry, testVaultBytes } from "../test/vault-fixtures";
import {
	BrambleFileError,
	type BrambleImportDeps,
	DamagedAttachmentError,
	openBrambleFile,
	storeSealedAttachment,
} from "./bramble";
import type { SealedSource } from "./types";

// The crypto is pinned natively (core-rust portable_vault_tests: open_vault_backup). What these
// cover is the TS half: telling an export from a backup, what of a backup comes in, and where
// each attachment's bytes and keys come from.

const stored = (bytes: Uint8Array) => [bytes, { level: 0 as const }] as [Uint8Array, { level: 0 }];
const hlc = { wall: 1, counter: 0, node: "n" };

/** A backup's entry as its payload holds it. The fake core "decrypts" by parsing `ciphertext`. */
function sealedEntry(id: string, data: object, extra: object = {}) {
	return {
		id,
		wrappedDek: "wd",
		dekIv: "di",
		ciphertext: JSON.stringify(data),
		iv: "iv",
		hlc,
		...extra,
	};
}

function fakeDeps(payload: object | null) {
	const openVaultBackup = vi.fn(async (input: OpenVaultBackupInput) => ({
		entries: input.entries.map((e) => (e.ciphertext === "damaged" ? null : e.ciphertext)),
		files: input.files.map((f) =>
			f.wrappedFek === "damaged" ? null : { wrappedFek: `moved:${f.wrappedFek}`, fekIv: "new-iv" },
		),
	}));
	const deps = {
		crypto: {
			openPortableVault: vi.fn(async () => (payload === null ? null : JSON.stringify(payload))),
			openVaultBackup,
		},
		describe: vi.fn(async (record: FileRecord) => {
			if (!record.wrappedFek.startsWith("moved:")) throw new Error("not this vault's key");
			return { name: `${record.metaBlob}.pdf`, mime: "application/pdf" };
		}),
	} satisfies BrambleImportDeps;
	return { deps, openVaultBackup };
}

async function archiveOf(blobs: Uint8Array[]) {
	const files: Record<string, [Uint8Array, { level: 0 }]> = {
		[VAULT_ENTRY]: stored(testVaultBytes(fill(20, 7))),
	};
	const hashes: string[] = [];
	for (const b of blobs) {
		const hash = await sha256Hex(b);
		hashes.push(hash);
		files[`blobs/${hash}`] = stored(b);
	}
	return { bytes: zipSync(files), hashes };
}

const plainFile = () => bytesSource(testVaultBytes(fill(20, 7)));

describe("openBrambleFile", () => {
	it("takes a portable export's entries as they are", async () => {
		const { deps, openVaultBackup } = fakeDeps({ entries: [loginEntry("a")] });
		const res = await openBrambleFile(deps, plainFile(), "pw");
		expect(res?.imported.map((e) => e.name)).toEqual(["a"]);
		expect(res?.attachments).toBeUndefined();
		expect(openVaultBackup).not.toHaveBeenCalled();
	});

	// null, not a throw, so the dialog can say "wrong password" rather than "corrupt file".
	it("returns null for a wrong password", async () => {
		const { deps } = fakeDeps(null);
		expect(await openBrambleFile(deps, plainFile(), "wrong")).toBeNull();
	});

	it("names a file that isn't a .bramble", async () => {
		const { deps } = fakeDeps({ entries: [] });
		const err = await openBrambleFile(deps, bytesSource(new Uint8Array([1, 2, 3])), "pw").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(BrambleFileError);
		expect((err as BrambleFileError).reason).toBe("not-a-backup");
	});

	// The case that used to be turned away with "Restore it instead".
	it("opens a full backup's entries to merge, without its ids or this-vault bookkeeping", async () => {
		const { deps, openVaultBackup } = fakeDeps({
			entries: [
				sealedEntry("id-a", { ...loginEntry("a"), id: "id-a", partStamps: { credential: hlc } }),
				sealedEntry("id-b", loginEntry("b")),
			],
			tombstones: [],
		});
		const res = await openBrambleFile(deps, plainFile(), "pw");
		expect(res?.imported).toEqual([loginEntry("a"), loginEntry("b")]);
		expect(res?.byType).toEqual({ login: 2 });
		expect(res?.leftOut).toEqual({ items: 0, attachments: 0 });
		expect(openVaultBackup.mock.calls[0]?.[0]).toMatchObject({ password: "pw", files: [] });
	});

	// The hidden unlock key is the backed-up device's own.
	it("leaves local-only entries behind, uncounted", async () => {
		const { deps } = fakeDeps({
			entries: [
				sealedEntry("a", loginEntry("a")),
				sealedEntry("k", loginEntry("unlock key"), { localOnly: true }),
			],
			tombstones: [],
		});
		const res = await openBrambleFile(deps, plainFile(), "pw");
		expect(res?.imported.map((e) => e.name)).toEqual(["a"]);
		expect(res?.leftOut?.items).toBe(0);
	});

	it("counts an entry that won't open rather than dropping it silently", async () => {
		const payload = {
			entries: [
				sealedEntry("a", loginEntry("a")),
				{ ...sealedEntry("b", {}), ciphertext: "damaged" },
			],
			tombstones: [],
		};
		const res = await openBrambleFile(fakeDeps(payload).deps, plainFile(), "pw");
		expect(res?.imported.map((e) => e.name)).toEqual(["a"]);
		expect(res?.leftOut?.items).toBe(1);
	});

	it("brings an archive's attachments, sealed as they are, under keys moved to this vault", async () => {
		const { bytes, hashes } = await archiveOf([fill(30, 1)]);
		const record = fileRecord({
			id: "f1",
			entryId: "a",
			hash: hashes[0],
			size: 30,
			metaBlob: "scan",
		});
		const { deps, openVaultBackup } = fakeDeps({
			entries: [sealedEntry("a", loginEntry("a"))],
			tombstones: [],
			files: [record],
		});
		const res = await openBrambleFile(deps, bytesSource(bytes), "pw");
		expect(openVaultBackup.mock.calls[0]?.[0].files).toEqual([{ wrappedFek: "wf", fekIv: "fi" }]);
		const [a] = res?.attachments ?? [];
		// On the very entry object being imported, so it follows that entry through the import.
		expect(a?.entry).toBe(res?.imported[0]);
		expect(a).toMatchObject({ name: "scan.pdf", mime: "application/pdf" });
		const source = a?.source as SealedSource;
		expect(source.kind).toBe("sealed");
		expect(source.sealed).toEqual({
			hash: hashes[0],
			size: 30,
			wrappedFek: "moved:wf",
			fekIv: "new-iv",
			noncePrefix: "np",
			metaBlob: "scan",
			metaIv: "mi",
		});
		expect(res?.leftOut).toEqual({ items: 0, attachments: 0 });
	});

	it("counts the attachments that can't come: no bytes in the file, no entry, or a bad key", async () => {
		const { bytes, hashes } = await archiveOf([fill(30, 1), fill(31, 2)]);
		const records = [
			// Fine.
			fileRecord({ id: "ok", entryId: "a", hash: hashes[0] }),
			// Its key won't open.
			fileRecord({ id: "bad-key", entryId: "a", hash: hashes[1], wrappedFek: "damaged" }),
			// Its bytes aren't in the file.
			fileRecord({ id: "missing", entryId: "a", hash: "c".repeat(64) }),
			// On no entry at all.
			fileRecord({ id: "loose", hash: hashes[0] }),
		];
		const { deps, openVaultBackup } = fakeDeps({
			entries: [sealedEntry("a", loginEntry("a"))],
			tombstones: [],
			files: records,
		});
		const res = await openBrambleFile(deps, bytesSource(bytes), "pw");
		// Only what can come is handed to the core.
		expect(openVaultBackup.mock.calls[0]?.[0].files).toHaveLength(2);
		expect(res?.attachments).toHaveLength(1);
		expect(res?.leftOut).toEqual({ items: 0, attachments: 3 });
	});

	// A delete takes its entry's files with it; a backup of that vault doesn't show them either.
	it("leaves out the files of an entry deleted before the backup, uncounted", async () => {
		const { bytes, hashes } = await archiveOf([fill(30, 1)]);
		const { deps } = fakeDeps({
			entries: [sealedEntry("a", loginEntry("a"))],
			tombstones: [{ id: "gone", hlc }],
			files: [fileRecord({ id: "f", entryId: "gone", hash: hashes[0] })],
			fileCascades: [{ id: "f", hlc }],
		});
		const res = await openBrambleFile(deps, bytesSource(bytes), "pw");
		expect(res?.attachments).toEqual([]);
		expect(res?.leftOut).toEqual({ items: 0, attachments: 0 });
	});
});

describe("storeSealedAttachment", () => {
	async function sourceFor(bytes: Uint8Array, hash?: string): Promise<SealedSource> {
		const archive = bytesSource((await archiveOf([bytes])).bytes);
		const opened = await openBackup(archive);
		const located = opened.kind === "archive" ? opened.attachments[0] : undefined;
		if (!located) throw new Error("expected an archive with one attachment");
		const at = { ...located, ...(hash ? { hash } : {}) };
		return { kind: "sealed", sealed: { ...fileRecord(), hash: at.hash }, archive, at };
	}

	it("copies the sealed bytes into the vault's store unchanged", async () => {
		const { store } = memoryBlobStore();
		const source = await sourceFor(fill(300, 9));
		expect(await storeSealedAttachment(store, source)).toBe(source.sealed);
		expect(await store.has(source.at.hash)).toBe(true);
	});

	it("refuses bytes that aren't what their name says, storing nothing", async () => {
		const { store } = memoryBlobStore();
		const source = await sourceFor(fill(300, 9), "d".repeat(64));
		await expect(storeSealedAttachment(store, source)).rejects.toBeInstanceOf(
			DamagedAttachmentError,
		);
		expect(await store.has("d".repeat(64))).toBe(false);
	});
});
